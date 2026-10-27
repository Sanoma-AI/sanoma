import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChangeReport,
  type Connector,
  memoryLedger,
  type RemoteEvent,
  SanomaClient,
  type Source,
} from "../src/index.ts";
import { fakeRemote, memorySource, sha } from "./fakes/remote.ts";
import { freshDatabase, pending, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. `SanomaClient.remoteEvent`, what a host's webhook says happened,
// over a fake host and a repository in memory: a push to a draft's branch plans its change again,
// a closed pull request ends it, a push to `main` applies the declared hosts; each once, however
// often it is delivered.

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
`;
const repo = { owner: "acme", name: "company" };
const BY = { by: "host-check" };

/** A test worker on a fresh database over `connectors` and `root`, given `source`, and a client given it too. */
function useRemoteApp(connectors: Connector<any, any>[], root: string, suffix: string, source: Source) {
  const app = useTestApp(
    { workflows: [], connectors, ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase(suffix), source },
  );
  let client: SanomaClient | undefined;
  beforeAll(async () => {
    client = await SanomaClient.connect(app.config, { source });
  });
  afterAll(() => client?.close());
  return {
    app,
    get client() {
      return client!;
    },
  };
}

describe("remoteEvent on a change", () => {
  const root = rootWith({ "resources/people.ts": PEOPLE });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  const used = useRemoteApp([remote.connector], root, "remote-event", source.source);
  const { app } = used;
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
    await used.client.remoteEvent(event, BY);
    // Delivered again: the draft holds the head already, so nothing more.
    await used.client.remoteEvent(event, BY);
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

  it("ignores the run's own push, a branch that is no draft's, a draft with no change, and another repository", async () => {
    const runId = await open("own");
    const { head } = (await app.client.change("own"))!.state;
    const follows = source.follows.length;
    for (const event of [
      { kind: "pushed", repo, branch: "draft/own", head: head! },
      { kind: "pushed", repo, branch: "feature", head: sha("feature") },
      { kind: "pushed", repo, branch: "draft/none", head: sha("none") },
      { kind: "closed", repo, branch: "draft/none", number: 99, merged: false },
      { kind: "pushed", repo: { owner: "acme", name: "other" }, branch: "draft/own", head: sha("other") },
      // No host is declared, so a push to main applies nothing.
      { kind: "pushed", repo, branch: "main", head: sha("main") },
    ] satisfies RemoteEvent[]) {
      await used.client.remoteEvent(event, BY);
    }
    expect(source.follows.length).toBe(follows);
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
    await used.client.remoteEvent(event, BY);
    await used.client.remoteEvent(event, BY);
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", sha: merge });
    expect(remote.merges.map((m) => m.number)).not.toContain(pr.number);
    // Ended: a late delivery does nothing.
    await used.client.remoteEvent(event, BY);
  });

  it("tells a change its pull request closed on the host", async () => {
    const runId = await open("closed");
    const pr = remote.pullOf("draft/closed")!;
    remote.close(pr.number);
    await used.client.remoteEvent(
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
    await app.client.remoteEvent({ kind: "pushed", repo, branch: "draft/sourceless", head }, BY);
    expect(await source.source.head("draft/sourceless")).not.toBe(head);
    await app.client.changeEvent("sourceless", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });
});

describe("remoteEvent on a push to main", () => {
  const git = testRepository();
  const root = rootWith({
    "resources/people.ts": PEOPLE,
    "resources/infra.ts": [
      'import { testhost } from "@sanoma-ai/testing-host/resources";',
      "",
      `export const app = testhost.app({ name: "company", source: ${JSON.stringify(git.url)}, ref: "main", port: 0 });`,
      "",
    ].join("\n"),
  });
  // While `held`, the host does not start: an apply of it waits.
  let held: Promise<void> | undefined;
  const host = fakeHost(async () => {
    await held;
    return { url: "http://127.0.0.1:4100", stop: async () => {} };
  });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  const used = useRemoteApp([host.connector, remote.connector], root, "remote-event-main", source.source);
  const { app } = used;
  beforeAll(() => git.commit());
  afterAll(async () => {
    await host.close();
    git.remove();
    source.remove();
  });

  it("applies the declared hosts as the host check, once per pushed head", async () => {
    const head = await git.commit();
    const event: RemoteEvent = { kind: "pushed", repo, branch: "main", head };
    await used.client.remoteEvent(event, BY);
    await used.client.remoteEvent(event, BY);
    const runs = await app.client.runs({ workflow: "apply" });
    expect(runs).toEqual([
      expect.objectContaining({ runId: `deploy:${head}`, startedBy: expect.objectContaining({ id: "host-check" }) }),
    ]);
    const report = await app.client.applyReport(`deploy:${head}`);
    expect(report.results).toEqual([expect.objectContaining({ id: "resources/infra.ts#app", status: "done" })]);
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
    await used.client.remoteEvent({ kind: "pushed", repo, branch: "main", head: merge }, BY);
    gate.resolve();
    expect(await app.client.result(runId, 60_000)).toMatchObject({
      outcome: "merged",
      deploy: { apply: { runId: `${runId}:deploy` } },
    });
    expect((await app.client.runs({ workflow: "apply" })).map((r) => r.runId)).not.toContain(`deploy:${merge}`);
  });
});
