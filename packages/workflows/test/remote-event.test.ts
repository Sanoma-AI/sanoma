import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChangeReport, memoryLedger, type RemoteEvent, SanomaClient } from "../src/index.ts";
import { fakeRemote, memorySource, sha } from "./fakes/remote.ts";
import { ALICE, freshDatabase, pending, rootWith, testhostInfra, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. `SanomaClient.remoteEvent`, what a host's webhook says happened,
// over a fake host and a repository in memory, on the test client, which is given the worker's
// repository: a push to a draft's branch plans its change again, a closed pull request ends it, a
// push to `main` applies the declared hosts; each once, however often it is delivered.

const repo = { owner: "acme", name: "company" };
const BY = { by: "host-check" };

describe("remoteEvent on a change", () => {
  const root = rootWith({ "resources/people.ts": ALICE });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  const app = useTestApp(
    { workflows: [], connectors: [remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("remote-event"), source: source.source },
  );
  afterAll(() => source.remove());

  const open = async (id: string) => {
    source.edit(id, { [`notes/${id}.md`]: "\n" });
    const runId = await app.client.openChange({ id, title: `Change ${id}` }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    return runId;
  };

  it("fetches a push to a draft's branch into the draft and tells its change, once", async () => {
    const runId = await open("pushed");
    const head = sha("someone's commit");
    remote.push("draft/pushed", head);
    const event: RemoteEvent = { kind: "pushed", repo, branch: "draft/pushed", head };
    await app.client.remoteEvent(event, BY);
    // Delivered again: the draft holds the head already, so nothing more.
    await app.client.remoteEvent(event, BY);
    expect(source.follows).toEqual([{ url: remote.url, token: expect.any(String), ref: "draft/pushed" }]);
    expect(await source.source.head("draft/pushed")).toBe(head);

    // The host check may not withdraw Publish: the run reads the event when it is decided, and plans again.
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    await waitFor(pending(() => app.client, runId, 2));
    expect((await app.client.change("pushed"))!.state).toMatchObject({ head, phase: "waiting" });
    expect(remote.merges).toEqual([]);
    await app.client.changeEvent("pushed", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });

  it("ignores the run's own push, another pull request, a branch that is no draft's, a draft with no change, and another repository", async () => {
    const runId = await open("own");
    const { head, pullRequest } = (await app.client.change("own"))!.state;
    const follows = source.follows.length;
    for (const event of [
      { kind: "pushed", repo, branch: "draft/own", head: head! },
      // An earlier change's pull request of the same draft.
      { kind: "closed", repo, branch: "draft/own", number: pullRequest!.number + 100, merged: false },
      { kind: "pushed", repo, branch: "feature", head: sha("feature") },
      { kind: "pushed", repo, branch: "draft/none", head: sha("none") },
      { kind: "closed", repo, branch: "draft/none", number: 99, merged: false },
      { kind: "pushed", repo: { owner: "acme", name: "other" }, branch: "main", head: sha("other") },
    ] satisfies RemoteEvent[]) {
      await app.client.remoteEvent(event, BY);
    }
    expect(source.follows.length).toBe(follows);
    // No host is declared: a push to main moves the checkout, and applies nothing.
    await app.client.remoteEvent({ kind: "pushed", repo, branch: "main", head: sha("main") }, BY);
    expect(source.follows.slice(follows)).toEqual([{ url: remote.url, token: expect.any(String), ref: "main" }]);
    expect(await app.client.runs({ workflow: "apply" }).catch(() => [])).toEqual([]);
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged" });
  });

  it("tells a change its pull request merged on the host, which it checks, and deploys", async () => {
    const runId = await open("merged");
    const pr = remote.pullOf("draft/merged")!;
    const merge = remote.merge(pr.number);
    const event: RemoteEvent = {
      kind: "closed",
      repo,
      branch: "draft/merged",
      number: pr.number,
      merged: true,
      sha: merge,
    };
    await app.client.remoteEvent(event, BY);
    await app.client.remoteEvent(event, BY);
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", sha: merge });
    expect(remote.merges.map((m) => m.number)).not.toContain(pr.number);
    // Ended: a late delivery does nothing.
    await app.client.remoteEvent(event, BY);
  });

  it("tells a change its pull request closed on the host", async () => {
    const runId = await open("closed");
    const pr = remote.pullOf("draft/closed")!;
    remote.close(pr.number);
    await app.client.remoteEvent(
      { kind: "closed", repo, branch: "draft/closed", number: pr.number, merged: false },
      BY,
    );
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
  });

  it("does nothing for a client given no repository", async () => {
    const runId = await open("sourceless");
    const head = sha("sourceless");
    remote.push("draft/sourceless", head);
    const sourceless = await SanomaClient.connect(app.config);
    try {
      await sourceless.remoteEvent({ kind: "pushed", repo, branch: "draft/sourceless", head }, BY);
    } finally {
      await sourceless.close();
    }
    expect(await source.source.head("draft/sourceless")).not.toBe(head);
    await app.client.changeEvent("sourceless", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });
});

describe("remoteEvent on a push to main", () => {
  const git = testRepository();
  const root = rootWith({ "resources/people.ts": ALICE, "resources/infra.ts": testhostInfra(git.url) });
  // While `held`, the host does not start: an apply of it waits.
  let held: Promise<void> | undefined;
  const host = fakeHost(async () => {
    await held;
    return { url: "http://127.0.0.1:4100", stop: async () => {} };
  });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  const app = useTestApp(
    { workflows: [], connectors: [host.connector, remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("remote-event-main"), source: source.source },
  );
  beforeAll(() => git.commit());
  afterAll(async () => {
    await host.close();
    git.remove();
    source.remove();
  });

  it("applies the declared hosts as the host check, once per pushed head", async () => {
    const head = await git.commit();
    const event: RemoteEvent = { kind: "pushed", repo, branch: "main", head };
    await app.client.remoteEvent(event, BY);
    await app.client.remoteEvent(event, BY);
    const runs = await app.client.runs({ workflow: "apply" });
    expect(runs).toEqual([
      expect.objectContaining({ runId: `deploy:${head}`, startedBy: expect.objectContaining({ id: "host-check" }) }),
    ]);
    const report = await app.client.applyReport(`deploy:${head}`);
    expect(report.results).toEqual([expect.objectContaining({ id: "resources/infra.ts#app", status: "done" })]);
    // The checkout followed main first, once.
    expect(source.follows).toEqual([{ url: remote.url, token: expect.any(String), ref: "main" }]);
  });

  it("leaves main to a change that is deploying it: the change applies the hosts itself", async () => {
    const gate = Promise.withResolvers<void>();
    held = gate.promise;
    await git.commit();
    source.edit("ship", { "notes/ship.md": "\n" });
    const runId = await app.client.openChange({ id: "ship", title: "Ship it" }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    await waitFor(async () => (await app.client.change("ship"))?.state.phase === "deploying");
    const merge = remote.branches.get("main")!;
    await app.client.remoteEvent({ kind: "pushed", repo, branch: "main", head: merge }, BY);
    gate.resolve();
    expect(await app.client.result(runId, 60_000)).toMatchObject({
      outcome: "merged",
      deploy: { apply: { runId: `${runId}:deploy` } },
    });
    expect((await app.client.runs({ workflow: "apply" })).map((r) => r.runId)).not.toContain(`deploy:${merge}`);
  });
});
