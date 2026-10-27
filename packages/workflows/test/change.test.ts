import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { fakeHost, testRepository } from "@sanoma-ai/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { lintWorkflow } from "../src/lint.ts";
import { CHANGE_MERGE, type ChangeReport, defineWorkflow, type LedgerRecord, memoryLedger } from "../src/index.ts";
import { fakeRemote, memorySource } from "./fakes/remote.ts";
import { freshDatabase, pending, rootWith, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The change workflow end to end over a fake host and a repository
// in memory: open, plan, hold, Publish, merge, deploy. The repository's root is this directory,
// so a draft that edits this file edits the workflow below, whose waiting runs it strands.

const here = dirname(fileURLToPath(import.meta.url));
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const ada = sanoma.person({ id: "ada" });
export const bob = sanoma.person({ id: "bob" });
export const admin = sanoma.group({ name: "admin", members: [ada] });
`;
// A change that touches secret/ is denied: anything else is allowed, but for the runtime's own rule.
const POLICY = `@id("no-secrets")
@reason("A change to secret/ is refused")
forbid (principal, action == Sanoma::Action::"sanoma.change.merge", resource is Sanoma::Change)
when { resource.touches.contains("secret/") };
`;
const page = (id: string) => `https://sanoma.example/changes/${id}`;

/** A workflow of this file, which waits: a draft that edits this file strands its runs. */
const waits = defineWorkflow({
  name: "waits",
  trigger: "manual",
  input: z.object({}),
  uses: ["sleep"],
  run: async (ctx) => {
    await ctx.sleep({ hours: 1 });
  },
});

const merges = (records: LedgerRecord[]) =>
  records.filter((r) => r.type === "op.called" && r.op === CHANGE_MERGE && !r.error);
const opsOf = (records: LedgerRecord[]) => records.flatMap((r) => (r.type === "op.called" ? [r.op] : []));

describe("the change workflow", () => {
  const root = rootWith({ "resources/people.ts": PEOPLE, "policies/no-secrets.cedar": POLICY });
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  const app = useTestApp(
    { workflows: [waits], connectors: [remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("change"), source: repo.source },
  );
  afterAll(() => repo.remove());

  const open = (id: string, title = `Change ${id}`) =>
    app.client.openChange({ id, title, page: page(id) }, { startedBy: "alice" });
  const phaseOf = async (id: string) => (await app.client.change(id))?.state.phase;

  it("is held to the workflow lint, as every built-in is", () => {
    const path = fileURLToPath(new URL("../src/change-workflow.ts", import.meta.url));
    expect(lintWorkflow(readFileSync(path, "utf8"), path)).toEqual([]);
  });

  it("holds a change to the rules for admin; Publish squash-merges it, follows main and reports", async () => {
    const head = repo.edit("rules", { "policies/x.cedar": "// nothing yet\n" });
    const runId = await open("rules", "Tighten the rules");
    expect(runId).toBe("change:rules");
    await waitFor(pending(() => app.client, runId));
    // A second open while the run waits is the same run.
    expect(await open("rules", "Tighten the rules")).toBe(runId);

    const pr = remote.pullOf("draft/rules")!;
    expect(pr).toMatchObject({ state: "open", base: "main", title: "Tighten the rules", head });
    const facts = {
      touches: ["policies/", "policies/x.cedar"],
      strandedRuns: 0,
      stranded: [],
      checksOk: true,
      rules: true,
    };
    const view = (await app.client.change("rules"))!;
    expect(view).toMatchObject({
      runId,
      status: "waiting",
      startedBy: { id: "alice" },
      state: {
        id: "rules",
        branch: "draft/rules",
        title: "Tighten the rules",
        page: page("rules"),
        phase: "waiting",
        head,
        pullRequest: { number: pr.number, url: pr.url },
        facts,
        check: { ok: true },
        decision: { answer: "hold", approver: { group: "admin" }, title: "A change to the rules waits for admin" },
        card: { status: "unavailable" },
      },
    });
    const [publish] = view.approvals;
    expect(publish).toMatchObject({
      title: "Publish the change",
      approver: { group: "admin" },
      covers: [CHANGE_MERGE],
      links: [pr.url, page("rules")],
      status: "pending",
    });
    expect(JSON.parse(publish!.details!)).toEqual({
      change: { id: "rules", title: "Tighten the rules", branch: "draft/rules" },
      facts,
    });
    expect(remote.statuses).toEqual([
      { sha: head, state: "pending", description: "A change to the rules waits for admin", targetUrl: page("rules") },
    ]);

    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    const report = (await app.client.result(runId)) as ChangeReport;
    const sha = remote.branches.get("main")!;
    expect(report).toEqual({
      outcome: "merged",
      head,
      pullRequest: { number: pr.number, url: pr.url },
      sha,
      deploy: { follow: { revision: sha } },
    });
    expect(remote.merges).toEqual([
      { number: pr.number, sha: head, method: "squash", title: `Tighten the rules (#${pr.number})` },
    ]);
    expect(remote.statuses.at(-1)).toMatchObject({ sha: head, state: "success" });
    expect(remote.deleted).toEqual(["draft/rules"]);
    expect(repo.follows).toEqual([{ url: remote.url, token: expect.any(String), ref: "main" }]);
    expect(repo.closed).toEqual(["rules"]);

    // The ledger's merge records the facts the policy decided on.
    const records = await app.client.ledger(runId);
    expect(merges(records)).toEqual([expect.objectContaining({ input: expect.objectContaining({ facts }) })]);
    const done = (await app.client.change("rules"))!;
    expect(done).toMatchObject({ status: "finished", state: { phase: "merged", merged: { sha } }, report });
    // Once it has ended, the draft's next change is a run of its own.
    repo.edit("rules", { "policies/y.cedar": "\n" });
    const again = await open("rules", "More rules");
    expect(again).toBe("change:rules~2");
    await waitFor(pending(() => app.client, again));
    await app.client.changeEvent("rules", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(again);
  });

  it("withdraws Publish when new commits come in, plans again, and asks again", async () => {
    repo.edit("again", { "policies/a.cedar": "\n" });
    const runId = await open("again");
    await waitFor(pending(() => app.client, runId));
    const head = repo.edit("again", { "policies/b.cedar": "\n" });
    await app.client.changeEvent("again", { kind: "commits" }, { by: "alice" });
    await waitFor(pending(() => app.client, runId, 2));
    const view = (await app.client.change("again"))!;
    expect(view.approvals[0]).toMatchObject({
      status: "withdrawn",
      withdrawnBy: "alice",
      withdrawnReason: "The change has new commits",
    });
    expect(view.state).toMatchObject({
      head,
      facts: { touches: ["policies/", "policies/a.cedar", "policies/b.cedar"] },
      decision: { answer: "hold" },
    });
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged", head });
    expect(remote.merges.at(-1)).toMatchObject({ sha: head });
  });

  it("plans again when the branch moved at the merge: the approval given for the old head lifts nothing", async () => {
    repo.edit("moved", { "policies/m.cedar": "\n" });
    const runId = await open("moved");
    await waitFor(pending(() => app.client, runId));
    remote.failMerge("head_moved");
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    await waitFor(pending(() => app.client, runId, 2));
    const view = (await app.client.change("moved"))!;
    expect(view.approvals.map((a) => a.status)).toEqual(["withdrawn", "pending"]);
    expect(view.approvals[0]).toMatchObject({ withdrawnReason: "the change was planned again at a new head" });
    expect(view.state.decision).toMatchObject({ answer: "hold", approver: { group: "admin" } });
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged" });
    // The first merge was refused: one squash merge was made.
    expect(remote.merges.filter((m) => m.number === remote.pullOf("draft/moved")!.number)).toHaveLength(1);
  });

  it("closes the pull request on a close event, and reports the change closed", async () => {
    repo.edit("dropped", { "notes/idea.md": "maybe\n" });
    const runId = await open("dropped");
    await waitFor(pending(() => app.client, runId));
    // Allowed: Publish is whoever drafted it.
    expect((await app.client.change("dropped"))!.state.decision).toEqual({ answer: "allow", approver: "alice" });
    await app.client.changeEvent("dropped", { kind: "close", by: "someone else" }, { by: "alice" });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
    expect(remote.pullOf("draft/dropped")).toMatchObject({ state: "closed" });
    const view = (await app.client.change("dropped"))!;
    expect(view.state).toMatchObject({ phase: "closed", closedBy: "alice" });
    expect(view.approvals[0]).toMatchObject({ status: "withdrawn", withdrawnBy: "alice" });
    // Nothing merged, and the draft stays.
    expect(repo.closed).not.toContain("dropped");
    await expect(app.client.changeEvent("dropped", { kind: "commits" }, { by: "alice" })).rejects.toMatchObject({
      code: "run_ended",
    });
  });

  it("reports a pull request closed on the host closed, without closing it again", async () => {
    repo.edit("gone", { "notes/gone.md": "\n" });
    const runId = await open("gone");
    await waitFor(pending(() => app.client, runId));
    remote.close(remote.pullOf("draft/gone")!.number);
    await app.client.changeEvent("gone", { kind: "closed" }, { by: "alice" });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
    expect(opsOf(await app.client.ledger(runId))).not.toContain("sanoma.change.close");
  });

  it("checks a merged or closed event on the host: one the pull request does not bear out plans again", async () => {
    repo.edit("told", { "notes/told.md": "\n" });
    const runId = await open("told");
    await waitFor(pending(() => app.client, runId));
    await app.client.changeEvent("told", { kind: "merged", sha: "0".repeat(40) }, { by: "alice" });
    await waitFor(pending(() => app.client, runId, 2));
    expect((await app.client.change("told"))!.state.phase).toBe("waiting");
    expect(remote.pullOf("draft/told")).toMatchObject({ state: "open" });
    expect(repo.closed).not.toContain("told");
    await app.client.changeEvent("told", { kind: "close", by: "alice" }, { by: "alice" });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
  });

  it("waits, blocked, when Publish is withdrawn with no event; new commits ask again", async () => {
    repo.edit("taken", { "notes/taken.md": "\n" });
    const runId = await open("taken");
    await waitFor(pending(() => app.client, runId));
    const [publish] = (await app.client.change("taken"))!.approvals;
    await app.client.withdraw(runId, publish!.id, "not yet", { by: "alice" });
    await waitFor(async () => (await phaseOf("taken")) === "blocked");
    expect((await app.client.change("taken"))!.state.blocked).toBe("Publish was withdrawn");
    await app.client.changeEvent("taken", { kind: "commits" }, { by: "alice" });
    await waitFor(pending(() => app.client, runId, 2));
    await app.client.changeEvent("taken", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });

  it("is started only by openChange, which names its run", async () => {
    await expect(
      app.client.start("change", { id: "side", title: "Side door" }, { startedBy: "alice" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("closes the change when Publish is rejected", async () => {
    repo.edit("rejected", { "notes/no.md": "\n" });
    const runId = await open("rejected");
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "reject", by: { id: "alice" }, note: "not now" });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "closed" });
    expect(remote.pullOf("draft/rejected")).toMatchObject({ state: "closed" });
    expect((await app.client.change("rejected"))!.state).toMatchObject({ closedBy: "alice" });
  });

  it("waits while the policy denies it, through a restart, and plans again on new commits", async () => {
    const denied = repo.edit("secret", { "secret/key.txt": "hunter2\n" });
    const runId = await open("secret");
    await waitFor(async () => (await phaseOf("secret")) === "blocked");
    expect((await app.client.change("secret"))!.state).toMatchObject({
      decision: { answer: "deny", reason: "A change to secret/ is refused" },
      blocked: "A change to secret/ is refused",
    });
    expect(remote.statuses.at(-1)).toMatchObject({ sha: denied, state: "failure" });
    expect((await app.client.change("secret"))!.approvals).toEqual([]);
    // With no approval to withdraw, a close is the starter's or admin's.
    await expect(app.client.changeEvent("secret", { kind: "close", by: "bob" }, { by: "bob" })).rejects.toMatchObject({
      code: "not_approver",
    });

    await app.restart();
    const head = repo.edit("secret", { "secret/key.txt": null, "notes/safe.md": "\n" });
    await app.client.changeEvent("secret", { kind: "commits" }, { by: "alice" });
    await waitFor(
      pending(() => app.client, runId),
      30_000,
    );
    expect((await app.client.change("secret"))!.state).toMatchObject({ head, decision: { answer: "allow" } });
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged", head });
  });

  it("counts the waiting runs of a workflow the change edits as stranded", async () => {
    const waiting = await app.client.start(waits, {}, { startedBy: "alice" });
    await waitFor(async () => (await app.client.ledger(waiting)).some((r) => r.type === "sleep.started"));
    repo.edit("strand", { "change.test.ts": "// edited\n" });
    const runId = await open("strand");
    await waitFor(pending(() => app.client, runId));
    expect((await app.client.change("strand"))!.state.facts).toMatchObject({
      touches: ["change.test.ts"],
      strandedRuns: 1,
      stranded: [waiting],
    });
    await app.client.changeEvent("strand", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });

  it("reports failing checks on the host, and still asks Publish", async () => {
    const head = repo.edit("unchecked", { "notes/unchecked.md": "\n" });
    repo.checks("unchecked", { ok: false, problems: [], warnings: [] });
    const runId = await open("unchecked");
    await waitFor(pending(() => app.client, runId));
    expect((await app.client.change("unchecked"))!.state.facts).toMatchObject({ checksOk: false });
    expect(remote.statuses.at(-1)).toMatchObject({
      sha: head,
      state: "failure",
      description: expect.stringMatching(/^sanoma check fails\. /),
    });
    await app.client.changeEvent("unchecked", { kind: "close", by: "alice" }, { by: "alice" });
    await app.client.result(runId);
  });

  it("refuses to open a change of a draft that is not there", async () => {
    const runId = await open("nothing");
    await expect(app.client.result(runId)).rejects.toThrow('There is no open draft "nothing"');
  });

  it("refuses an event for a draft with no change", async () => {
    await expect(app.client.changeEvent("never", { kind: "commits" }, { by: "alice" })).rejects.toMatchObject({
      code: "run_not_found",
    });
  });
});

describe("the change workflow on a repository with no remote", () => {
  const root = rootWith({});
  const repo = memorySource({ root: here });
  const app = useTestApp(
    { workflows: [], connectors: [], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("change-local"), source: repo.source },
  );
  afterAll(() => repo.remove());

  it("fails to open: saving is publishing", async () => {
    repo.edit("local", { "notes.md": "\n" });
    const runId = await app.client.openChange({ id: "local", title: "Local" }, { startedBy: "alice" });
    await expect(app.client.result(runId)).rejects.toThrow("saving is publishing: this repository has no remote");
  });
});

describe("the change workflow's deploy on a declared host", () => {
  const source = testRepository();
  const root = rootWith({
    "resources/infra.ts": [
      'import { testhost } from "@sanoma-ai/testing-host/resources";',
      "",
      `export const app = testhost.app({ name: "company", source: ${JSON.stringify(source.url)}, ref: "main", port: 0 });`,
      "",
    ].join("\n"),
  });
  const host = fakeHost(async () => ({ url: "http://127.0.0.1:4100", stop: async () => {} }));
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  const app = useTestApp(
    { workflows: [], connectors: [host.connector, remote.connector], ledger: memoryLedger(), root },
    { databaseUrl: freshDatabase("change-deploy"), source: repo.source },
  );
  beforeAll(() => source.commit());
  afterAll(async () => {
    await host.close();
    source.remove();
    repo.remove();
  });

  it("applies the hosts after the merge, waits for it, and reads them back", async () => {
    repo.edit("ship", { "workflows/ship.ts": "// ship it\n" });
    const runId = await app.client.openChange({ id: "ship", title: "Ship it" }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId, 60_000)) as ChangeReport;
    const hostId = "resources/infra.ts#app";
    expect(report).toMatchObject({
      outcome: "merged",
      deploy: { follow: { revision: expect.any(String) }, apply: { runId: `${runId}:deploy`, hosts: [hostId] } },
      verified: { runId: `${runId}:verify`, drifted: [] },
    });
    expect(report.deploy!.apply).not.toHaveProperty("error");
    const applied = await app.client.applyReport(`${runId}:deploy`);
    expect(applied.results).toEqual([expect.objectContaining({ id: hostId, status: "done" })]);
    // The checkout follows main first, so the hosts applied are the merged ones.
    expect(repo.follows).toEqual([{ url: remote.url, token: expect.any(String), ref: "main" }]);
  });
});
