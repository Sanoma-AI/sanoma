import { useTestApp } from "sanoma/testing/harness";
import { fakeHost, testRepository } from "sanoma/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChangeReport, type FollowOutput, memoryLedger, type RemoteEvent } from "../src/index.ts";
import { fakeRemote, memorySource, sha } from "./fakes/remote.ts";
import { ALICE, freshDatabase, pending, rootWith, testhostInfra, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The built-in `follow`, what a host's webhook says happened, started
// with `SanomaClient.follow` and run by the worker over its repository (in memory, on a fake host):
// a push to a draft's branch plans its change again, a closed pull request ends it, a push to
// `main` applies the declared hosts; one run per event, however often it is delivered. And how far
// an app taken from a source is behind it, which the worker tells at its start and after each
// follow of `main`.

const repo = { owner: "acme", name: "company" };

/** The follow run of `event`, its output once it ends: the same run however often it is started. */
const followed = async (
  client: { follow(e: RemoteEvent): Promise<string>; result(id: string): Promise<unknown> },
  event: RemoteEvent,
) => (await client.result(await client.follow(event))) as FollowOutput;

describe("follow on a change", () => {
  const root = rootWith({ "resources/people.ts": ALICE });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  const app = useTestApp(
    { workflows: [], connectors: [remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("follow"), source: source.source },
  );
  afterAll(() => source.remove());

  const open = async (id: string) => {
    source.edit(id, { [`notes/${id}.md`]: "\n" });
    const runId = await app.client.openChange({ id, title: `Change ${id}` }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    return runId;
  };

  it("fetches a push to a draft's branch into the draft and tells its change, in one run however often delivered", async () => {
    const runId = await open("pushed");
    const head = sha("someone's commit");
    remote.push("draft/pushed", head);
    const event: RemoteEvent = { kind: "pushed", repo, branch: "draft/pushed", head };
    const first = await app.client.follow(event);
    // Delivered again, its JSON laid out otherwise: the one run.
    expect(await app.client.follow({ head, branch: "draft/pushed", repo, kind: "pushed" })).toBe(first);
    expect(first).toMatch(/^follow:[0-9a-f]{64}$/);
    expect(await app.client.result(first)).toEqual({ change: "pushed", told: "commits" });
    expect((await app.client.runs({ workflow: "follow" })).map((r) => r.runId)).toEqual([first]);
    expect((await app.client.run(first))!.startedBy).toMatchObject({ id: "host-check" });
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
    const ignored = [
      { kind: "pushed", repo, branch: "draft/own", head: head! },
      // An earlier change's pull request of the same draft.
      { kind: "closed", repo, branch: "draft/own", number: pullRequest!.number + 100, merged: false },
      { kind: "pushed", repo, branch: "feature", head: sha("feature") },
      { kind: "pushed", repo, branch: "draft/none", head: sha("none") },
      { kind: "closed", repo, branch: "draft/none", number: 99, merged: false },
      { kind: "pushed", repo: { owner: "acme", name: "other" }, branch: "main", head: sha("other") },
    ] satisfies RemoteEvent[];
    for (const event of ignored) {
      expect(await followed(app.client, event)).toEqual({ ignored: expect.any(String) });
    }
    expect(source.follows.length).toBe(follows);
    // No host is declared: a push to main moves the checkout, and applies nothing.
    expect(await followed(app.client, { kind: "pushed", repo, branch: "main", head: sha("main") })).toEqual({
      followed: "main",
    });
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
    expect(await followed(app.client, event)).toEqual({ change: "merged", told: "merged" });
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", sha: merge });
    expect(remote.merges.map((m) => m.number)).not.toContain(pr.number);
  });

  it("tells a change its pull request closed on the host", async () => {
    const runId = await open("closed");
    const pr = remote.pullOf("draft/closed")!;
    remote.close(pr.number);
    expect(
      await followed(app.client, { kind: "closed", repo, branch: "draft/closed", number: pr.number, merged: false }),
    ).toEqual({ change: "closed", told: "closed" });
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
  });

  it("is started only by follow: another run id or another actor is refused", async () => {
    const event: RemoteEvent = { kind: "pushed", repo, branch: "main", head: sha("started") };
    const runId = await app.client.follow(event);
    await expect(app.client.start("follow", event, { startedBy: "alice", runId })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      app.client.start("follow", event, { startedBy: "host-check", runId: "follow:mine" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await app.client.result(runId);
  });
});

describe("follow on a worker given no repository", () => {
  const root = rootWith({ "resources/people.ts": ALICE });
  const remote = fakeRemote();
  const app = useTestApp(
    { workflows: [], connectors: [remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("follow-sourceless") },
  );

  it("does nothing, saying so", async () => {
    expect(await followed(app.client, { kind: "pushed", repo, branch: "main", head: sha("sourceless") })).toEqual({
      ignored: "This worker has no repository",
    });
  });
});

describe("follow a push to main", () => {
  const git = testRepository();
  const root = rootWith({
    "resources/people.ts": ALICE,
    "resources/infra.ts": testhostInfra(git.url),
    "apps/crm/app.ts":
      'import { defineApp } from "sanoma";\nexport default defineApp({ source: "https://github.com/example/crm" });\n',
    "apps/shop/app.ts": 'import { defineApp } from "sanoma";\nexport default defineApp({});\n',
  });
  // While `held`, the host does not start: an apply of it waits.
  let held: Promise<void> | undefined;
  const host = fakeHost(async () => {
    await held;
    return { url: "http://127.0.0.1:4100", stop: async () => {} };
  });
  const remote = fakeRemote();
  const source = memorySource({ root, remote });
  source.behindBy.set("crm", 2);
  const app = useTestApp(
    { workflows: [], connectors: [host.connector, remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("follow-main"), source: source.source },
  );
  beforeAll(() => git.commit());
  afterAll(async () => {
    await host.close();
    git.remove();
    source.remove();
  });

  it("tells how far each app taken from a source is behind it, at the worker's start", async () => {
    await waitFor(async () => (await app.client.appBehind("crm")) !== undefined);
    expect(await app.client.appBehind("crm")).toEqual({ behind: 2 });
    // The company's own app has no source to be behind.
    expect(await app.client.appBehind("shop")).toBeUndefined();
  });

  it("applies the declared hosts as the host check, once per pushed head, and tells the apps again", async () => {
    source.behindBy.set("crm", new Error("git fetch from https://github.com/example/crm failed"));
    const head = await git.commit();
    const event: RemoteEvent = { kind: "pushed", repo, branch: "main", head };
    expect(await followed(app.client, event)).toEqual({ followed: "main", deploy: `deploy:${head}` });
    expect(await followed(app.client, event)).toEqual({ followed: "main", deploy: `deploy:${head}` });
    const runs = await app.client.runs({ workflow: "apply" });
    expect(runs).toEqual([
      expect.objectContaining({ runId: `deploy:${head}`, startedBy: expect.objectContaining({ id: "host-check" }) }),
    ]);
    const report = await app.client.applyReport(`deploy:${head}`);
    expect(report.results).toEqual([expect.objectContaining({ id: "resources/infra.ts#app", status: "done" })]);
    // The checkout followed main first, once.
    expect(source.follows).toEqual([{ url: remote.url, token: expect.any(String), ref: "main" }]);
    await waitFor(async () => "error" in ((await app.client.appBehind("crm")) ?? {}));
    expect(await app.client.appBehind("crm")).toEqual({
      error: "git fetch from https://github.com/example/crm failed",
    });
  });

  it("fails while the checkout cannot follow main, deploying nothing", async () => {
    const head = await git.commit();
    source.following(() => ({ skipped: "an uncommitted edit" }));
    const runId = await app.client.follow({ kind: "pushed", repo, branch: "main", head });
    await expect(app.client.result(runId)).rejects.toThrow(
      "main was not deployed: the checkout did not follow it: an uncommitted edit",
    );
    source.following((ref) => ({ revision: remote.branches.get(ref) ?? sha(ref) }));
    expect((await app.client.runs({ workflow: "apply" })).map((r) => r.runId)).not.toContain(`deploy:${head}`);
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
    expect(await followed(app.client, { kind: "pushed", repo, branch: "main", head: merge })).toEqual({
      ignored: expect.stringContaining("a change is deploying main"),
    });
    gate.resolve();
    expect(await app.client.result(runId, 60_000)).toMatchObject({
      outcome: "merged",
      deploy: { apply: { runId: `${runId}:deploy` } },
    });
    expect((await app.client.runs({ workflow: "apply" })).map((r) => r.runId)).not.toContain(`deploy:${merge}`);
  });
});
