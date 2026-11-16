import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { useTestApp } from "sanoma/testing/harness";
import { fakeHost, testRepository } from "sanoma/testing/host";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collection } from "../src/collection.ts";
import { lazyDb } from "../src/db.ts";
import { data } from "../src/db/company.ts";
import type { TableChangePlan } from "../src/description.ts";
import type { Source } from "../src/source.ts";
import { lintWorkflow } from "../src/lint.ts";
import { stillMade } from "../src/change-steps.ts";
import { CHANGE_MERGE, type ChangeReport, defineWorkflow, type LedgerRecord, memoryLedger } from "../src/index.ts";
import { fakeRemote, memorySource } from "./fakes/remote.ts";
import { freshDatabase, pending, rootWith, testhostInfra, waitFor } from "./harness.ts";

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
// A change that touches secret/ is denied, and so is a reshape of the archive's records, and of the
// leads', the accounts' and the orders' by alice; a reshape of the ledger's is held for admin: anything else is allowed, but for
// the runtime's own rule.
const POLICY = `@id("no-secrets")
@reason("A change to secret/ is refused")
forbid (principal, action == Sanoma::Action::"sanoma.change.merge", resource is Sanoma::Change)
when { resource.touches.contains("secret/") };

@id("archive-held")
@reason("The archive's records are held as they are")
forbid (principal, action == Sanoma::Action::"sanoma.records.reshape", resource == Sanoma::Target::"data:archive");

@id("leads-not-alice")
@reason("alice may not bring the leads along")
forbid (principal == Sanoma::Principal::"alice", action == Sanoma::Action::"sanoma.records.reshape", resource == Sanoma::Target::"data:leads");

@id("accounts-not-alice")
@reason("alice may not bring the accounts along")
forbid (principal == Sanoma::Principal::"alice", action == Sanoma::Action::"sanoma.records.reshape", resource == Sanoma::Target::"data:accounts");

@id("orders-not-alice")
@reason("alice may not bring the orders along")
forbid (principal == Sanoma::Principal::"alice", action == Sanoma::Action::"sanoma.records.reshape", resource == Sanoma::Target::"data:orders");

@id("ledger-held")
@hold("admin")
@title("Bringing the ledger along waits for admin")
forbid (principal, action == Sanoma::Action::"sanoma.records.reshape", resource == Sanoma::Target::"data:ledger");
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

/** Removing `legacy` for good from the collection `name`: what Try again's removals carry. */
const removal = (name: string): TableChangePlan => ({
  collection: name,
  rows: 1,
  changes: [{ kind: "remove", field: "legacy", filled: 1 }],
});

const merges = (records: LedgerRecord[]) =>
  records.filter((r) => r.type === "op.called" && r.op === CHANGE_MERGE && !r.error);
const opsOf = (records: LedgerRecord[]) => records.flatMap((r) => (r.type === "op.called" ? [r.op] : []));

/**
 * The collections Try again's tests bring along, as declared once their change merged: `prospects`
 * as it was before a rename to `contacted`, `accounts` with `legacy` removed for good, `vendors`
 * with a `legacy` declared again since its removal, and `orders` with `customer` linked to `accounts`.
 */
const collections = [
  collection({ name: "leads", key: "company", fields: { company: "text", contacted: "text" } }),
  collection({ name: "ledger", key: "company", fields: { company: "text", contacted: "text" } }),
  collection({ name: "prospects", key: "company", fields: { company: "text", touched: "text" } }),
  collection({ name: "accounts", key: "company", fields: { company: "text" } }),
  collection({
    name: "vendors",
    key: "company",
    fields: { company: "text", legacy: { type: "number", optional: true } },
  }),
  collection({ name: "orders", key: "id", fields: { id: "text", customer: { link: "accounts", optional: true } } }),
];

describe("the change workflow", () => {
  const root = rootWith({ "resources/people.ts": PEOPLE, "policies/no-secrets.cedar": POLICY });
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  const databaseUrl = freshDatabase("change");
  const app = useTestApp(
    { workflows: [waits], collections, connectors: [remote.connector], ledger: memoryLedger(), root },
    { databaseUrl, source: repo.source },
  );
  const pool = lazyDb(databaseUrl, "change test");
  afterAll(async () => {
    repo.remove();
    await pool.close();
  });

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
      covers: [CHANGE_MERGE, "sanoma.records.reshape"],
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
    // No plan: no records to bring along.
    expect(opsOf(records)).not.toContain("sanoma.records.reshape");
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

  it("publishes a saved change as its drafter at the head saved when the policy lets them decide it, and asks Publish otherwise", async () => {
    const save = (id: string, by: string, head: string) =>
      app.client.openChange({ id, title: `Save ${id}`, page: page(id), save: head }, { startedBy: by });
    // Allowed, Publish the drafter's: their Save is their Publish.
    const saved = await save("saved", "alice", repo.edit("saved", { "notes/saved.md": "\n" }));
    expect(await app.client.result(saved)).toMatchObject({ outcome: "merged" });
    expect((await app.client.change("saved"))!.approvals[0]).toMatchObject({
      status: "approved",
      decidedBy: "alice",
      note: "Saved",
    });
    // Held for admin, which the drafter is not in: Publish waits for ada.
    const held = await save("saved-rules", "alice", repo.edit("saved-rules", { "policies/saved.cedar": "\n" }));
    await waitFor(pending(() => app.client, held));
    await app.client.decide(held, { decision: "approve", by: { id: "ada" } });
    expect(await app.client.result(held)).toMatchObject({ outcome: "merged" });
    // Held for admin, and the drafter is its only member: nobody else could, so it is theirs.
    const ruled = repo.edit("admin-rules", { "policies/admin.cedar": "\n" });
    expect(await app.client.result(await save("admin-rules", "ada", ruled))).toMatchObject({ outcome: "merged" });
    // Saved at a head the draft has moved on from: Publish waits, the saved head is not the one planned.
    const old = repo.edit("moved-on", { "notes/one.md": "\n" });
    repo.edit("moved-on", { "notes/two.md": "\n" });
    const moved = await save("moved-on", "alice", old);
    await waitFor(pending(() => app.client, moved));
    await app.client.changeEvent("moved-on", { kind: "close", by: "alice" }, { by: "alice" });
    expect(await app.client.result(moved)).toMatchObject({ outcome: "closed" });
  });

  it("brings a collection's records along its plan once it merges, before it deploys, and reports what became of them", async () => {
    const db = await pool.db();
    await db.insert(data).values([
      {
        collection: "deals",
        key: "Acme",
        record: { company: "Acme", seats: "12", touched: "2026-01-02", legacy: "L-1" },
        updatedBy: "leon",
      },
      { collection: "deals", key: "Cedar", record: { company: "Cedar", seats: "about 40" }, updatedBy: "leon" },
    ]);
    const plan: TableChangePlan = {
      collection: "deals",
      rows: 2,
      changes: [
        { kind: "add", field: "region", type: "text", required: false, empty: 2 },
        { kind: "rename", from: "touched", to: "contacted" },
        {
          kind: "retype",
          field: "seats",
          from: "text",
          to: "number",
          wontConvert: { count: 1, sample: [{ key: "Cedar", value: "about 40" }] },
        },
        { kind: "remove", field: "legacy", filled: 1 },
      ],
    };
    const head = repo.edit("deals", { "notes/deals.md": "\n" });
    const runId = await app.client.openChange(
      { id: "deals", title: "Deal columns", page: page("deals"), save: head, plan },
      { startedBy: "alice" },
    );
    // The removed field's value deleted with the rest, as cleared.
    const reshaped = { rows: 2, changed: 1, converted: 1, cleared: 1, kept: 1 };
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged", reshaped, deploy: { follow: {} } });
    expect((await app.client.change("deals"))!.state).toMatchObject({ plan, merged: { reshaped } });
    // After the merge, under the run; a value that cannot convert is kept (no decision).
    expect(opsOf(await app.client.ledger(runId)).slice(-2)).toEqual([CHANGE_MERGE, "sanoma.records.reshape"]);
    const rows = await db.select().from(data).where(eq(data.collection, "deals")).orderBy(data.key);
    expect(rows.map((r) => [r.record, r.updatedBy])).toEqual([
      [{ company: "Acme", seats: 12, contacted: "2026-01-02" }, `run:${runId}`],
      [{ company: "Cedar", seats: "about 40" }, "leon"],
    ]);
  });

  it("reports a reshape that fails on the change, merged all the same, the run not failed", async () => {
    // A rename of the archive's field: the plan carries it, the policy denies the reshape.
    const plan: TableChangePlan = {
      collection: "archive",
      rows: 0,
      changes: [{ kind: "rename", from: "seats", to: "count" }],
    };
    const head = repo.edit("unnamed", { "notes/unnamed.md": "\n" });
    const runId = await app.client.openChange(
      { id: "unnamed", title: "Unnamed", page: page("unnamed"), save: head, plan },
      { startedBy: "alice" },
    );
    const reshaped = { error: expect.stringContaining("sanoma.records.reshape") };
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged", reshaped, deploy: { follow: {} } });
    expect(await app.client.change("unnamed")).toMatchObject({
      status: "finished",
      state: { phase: "merged", merged: { reshaped } },
    });
  });

  it("brings the records along again on Try again, as the person who asks, as often as asked", async () => {
    const db = await pool.db();
    await db
      .insert(data)
      .values([
        { collection: "leads", key: "Acme", record: { company: "Acme", touched: "2026-01-02" }, updatedBy: "leon" },
      ]);
    const plan: TableChangePlan = {
      collection: "leads",
      rows: 1,
      changes: [{ kind: "rename", from: "touched", to: "contacted" }],
    };
    const head = repo.edit("leads", { "notes/leads.md": "\n" });
    const runId = await app.client.openChange(
      { id: "leads", title: "Leads", page: page("leads"), save: head, plan },
      { startedBy: "alice" },
    );
    // Merged by alice, whom the policy refuses the records.
    expect(await app.client.result(runId)).toMatchObject({
      outcome: "merged",
      reshaped: { error: expect.any(String) },
    });
    expect((await app.client.change("leads"))!.retry).toBeUndefined();

    // Asked again by alice: refused again, as her.
    const first = await app.client.reshapeChange("leads", { startedBy: "alice" });
    expect(first).toBe("reshape:leads");
    expect(await app.client.result(first)).toEqual({
      error: expect.stringContaining("alice may not bring the leads along"),
    });
    expect((await app.client.change("leads"))!.retry).toMatchObject({
      runId: first,
      status: "finished",
      startedBy: { id: "alice" },
      reshaped: { error: expect.any(String) },
    });

    // By ada: brought along, under her, by her run.
    const second = await app.client.reshapeChange("leads", { startedBy: "ada" });
    expect(second).toBe("reshape:leads~2");
    const reshaped = { rows: 1, changed: 1, converted: 0, cleared: 0, kept: 0 };
    expect(await app.client.result(second)).toEqual(reshaped);
    expect((await app.client.change("leads"))!.retry).toMatchObject({ runId: second, status: "finished", reshaped });
    const [call] = (await app.client.ledger(second)).filter((r) => r.type === "op.called");
    expect(call).toMatchObject({ op: "sanoma.records.reshape", actor: { id: "ada" }, decision: { kind: "allow" } });
    const [row] = await db.select().from(data).where(eq(data.collection, "leads"));
    expect([row!.record, row!.updatedBy]).toEqual([{ company: "Acme", contacted: "2026-01-02" }, `run:${second}`]);

    // Again, once they are: nothing left to bring along.
    const third = await app.client.reshapeChange("leads", { startedBy: "ada" });
    expect(await app.client.result(third)).toEqual({ ...reshaped, changed: 0 });
    // Started only by reshapeChange, which names its run; and only for a change that merged.
    await expect(app.client.start("reshape", { id: "leads" }, { startedBy: "ada" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(app.client.result(await app.client.reshapeChange("nothing", { startedBy: "ada" }))).rejects.toThrow(
      "The draft nothing has no published change",
    );
  });

  it("refuses Try again once the collection's columns are no longer what the change made them", async () => {
    // `prospects` declares `touched` (made again by a later change, say): renaming it again would move its values.
    const plan: TableChangePlan = {
      collection: "prospects",
      rows: 0,
      changes: [{ kind: "rename", from: "touched", to: "contacted" }],
    };
    const head = repo.edit("prospects", { "notes/prospects.md": "\n" });
    const runId = await app.client.openChange(
      { id: "prospects", title: "Prospects", page: page("prospects"), save: head, plan },
      { startedBy: "alice" },
    );
    expect(await app.client.result(runId)).toMatchObject({ outcome: "merged", reshaped: { rows: 0 } });
    const retry = await app.client.reshapeChange("prospects", { startedBy: "ada" });
    await expect(app.client.result(retry)).rejects.toThrow(
      "The columns of prospects are no longer what the change of the draft prospects made them",
    );
  });

  it("deletes a removed field's values on Try again, and refuses it once a column of that name is declared again", async () => {
    const db = await pool.db();
    await db.insert(data).values([
      { collection: "accounts", key: "Acme", record: { company: "Acme", legacy: "L-1" }, updatedBy: "leon" },
      { collection: "accounts", key: "Globex", record: { company: "Globex" }, updatedBy: "leon" },
      { collection: "vendors", key: "Initech", record: { company: "Initech", legacy: 7 }, updatedBy: "leon" },
    ]);
    const merged = async (id: string) => {
      const head = repo.edit(id, { [`notes/${id}.md`]: "\n" });
      return app.client.result(
        await app.client.openChange(
          { id, title: id, page: page(id), save: head, plan: removal(id) },
          { startedBy: "alice" },
        ),
      );
    };
    // Merged by alice, whom the policy refuses the accounts: the declaration is gone, the values are not.
    expect(await merged("accounts")).toMatchObject({ outcome: "merged", reshaped: { error: expect.any(String) } });
    const legacyOf = async (name: string, key: string) =>
      (
        await db
          .select()
          .from(data)
          .where(and(eq(data.collection, name), eq(data.key, key)))
      )[0]?.record.legacy;
    expect(await legacyOf("accounts", "Acme")).toBe("L-1");
    const retry = await app.client.reshapeChange("accounts", { startedBy: "ada" });
    expect(await app.client.result(retry)).toEqual({ rows: 2, changed: 1, converted: 0, cleared: 1, kept: 0 });
    expect(await legacyOf("accounts", "Acme")).toBeUndefined();

    // `vendors` declares `legacy` again: replaying the removal would delete the new column's values.
    expect(await merged("vendors")).toMatchObject({ outcome: "merged" });
    // Its first call deleted the old values; the column declared since holds a new one.
    await db
      .update(data)
      .set({ record: { company: "Initech", legacy: 7 } })
      .where(and(eq(data.collection, "vendors"), eq(data.key, "Initech")));
    await expect(app.client.result(await app.client.reshapeChange("vendors", { startedBy: "ada" }))).rejects.toThrow(
      "The columns of vendors are no longer what the change of the draft vendors made them",
    );
    expect(await legacyOf("vendors", "Initech")).toBe(7);
  });

  it("links a column on Try again against the keys of the collection it links to, as the first call would have", async () => {
    const db = await pool.db();
    await db
      .insert(data)
      .values({ collection: "accounts", key: "Globex", record: { company: "Globex" }, updatedBy: "leon" })
      .onConflictDoNothing();
    await db.insert(data).values(
      [
        { id: "o1", customer: "Globex" },
        { id: "o2", customer: "Nobody" },
      ].map((record) => ({ collection: "orders", key: record.id, record, updatedBy: "leon" })),
    );
    const plan: TableChangePlan = {
      collection: "orders",
      rows: 2,
      changes: [
        {
          kind: "retype",
          field: "customer",
          from: "text",
          to: { link: "accounts" },
          decision: "clear",
          wontConvert: { count: 1, sample: [{ key: "o2", value: "Nobody" }] },
        },
      ],
    };
    const head = repo.edit("orders", { "notes/orders.md": "\n" });
    const runId = await app.client.openChange(
      { id: "orders", title: "Orders", page: page("orders"), save: head, plan },
      { startedBy: "alice" },
    );
    expect(await app.client.result(runId)).toMatchObject({
      outcome: "merged",
      reshaped: { error: expect.any(String) },
    });
    // A key of accounts stays as it is; one that names no account is cleared, as chosen.
    const retry = await app.client.reshapeChange("orders", { startedBy: "ada" });
    expect(await app.client.result(retry)).toEqual({ rows: 2, changed: 1, converted: 0, cleared: 1, kept: 0 });
    const rows = await db.select().from(data).where(eq(data.collection, "orders")).orderBy(data.key);
    expect(rows.map((r) => r.record)).toEqual([{ id: "o1", customer: "Globex" }, { id: "o2" }]);
  });

  it("reports a hold on the records Publish does not lift without waiting on it, and Try again waits for its approver", async () => {
    const db = await pool.db();
    await db
      .insert(data)
      .values([
        { collection: "ledger", key: "Acme", record: { company: "Acme", touched: "2026-01-02" }, updatedBy: "leon" },
      ]);
    const plan: TableChangePlan = {
      collection: "ledger",
      rows: 1,
      changes: [{ kind: "rename", from: "touched", to: "contacted" }],
    };
    repo.edit("ledger", { "notes/ledger.md": "\n" });
    const runId = await app.client.openChange(
      { id: "ledger", title: "Ledger", page: page("ledger"), plan },
      { startedBy: "alice" },
    );
    await waitFor(pending(() => app.client, runId));
    // Merged on the host, with Publish never given: the change deploys, the records wait.
    const sha = remote.merge(remote.pullOf("draft/ledger")!.number);
    await app.client.changeEvent("ledger", { kind: "merged", sha }, { by: "alice" });
    const report = (await app.client.result(runId)) as ChangeReport;
    expect(report).toMatchObject({
      outcome: "merged",
      reshaped: { error: "Bringing the ledger along waits for admin" },
      deploy: { follow: { revision: expect.any(String) } },
    });
    // Asked, never called: no approval of it waits on the change.
    expect(opsOf(await app.client.ledger(runId))).not.toContain("sanoma.records.reshape");
    expect((await app.client.change("ledger"))!.approvals.filter((a) => a.status === "pending")).toEqual([]);

    const retry = await app.client.reshapeChange("ledger", { startedBy: "alice" });
    await waitFor(pending(() => app.client, retry));
    expect((await app.client.change("ledger"))!.retry).toMatchObject({ runId: retry, status: "waiting" });
    await app.client.decide(retry, { decision: "approve", by: { id: "ada" } });
    const reshaped = { rows: 1, changed: 1, converted: 0, cleared: 0, kept: 0 };
    expect(await app.client.result(retry)).toEqual(reshaped);
    expect((await app.client.change("ledger"))!.retry).toMatchObject({ status: "finished", reshaped });
    const [row] = await db.select().from(data).where(eq(data.collection, "ledger"));
    expect(row!.record).toEqual({ company: "Acme", contacted: "2026-01-02" });
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
  const root = rootWith({ "resources/infra.ts": testhostInfra(source.url) });
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

  const hostId = "resources/infra.ts#app";

  it("deploys no host the lockfile does not bind: going live makes it", async () => {
    repo.edit("early", { "notes/early.md": "\n" });
    const runId = await app.client.openChange({ id: "early", title: "Before going live" }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId, 60_000)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", deploy: { follow: { revision: expect.any(String) } } });
    expect(report.deploy).not.toHaveProperty("apply");
    expect(await app.client.runs({ workflow: "apply" })).toEqual([]);
  });

  it("applies the hosts after the merge, waits for it, and reads them back", async () => {
    // Gone live: its apply binds the host.
    await app.client.applyReport(await app.client.apply({ only: [hostId] }, { startedBy: "alice" }));
    repo.edit("ship", { "workflows/ship.ts": "// ship it\n" });
    const runId = await app.client.openChange({ id: "ship", title: "Ship it" }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId, 60_000)) as ChangeReport;
    expect(report).toMatchObject({
      outcome: "merged",
      deploy: { follow: { revision: expect.any(String) }, apply: { runId: `${runId}:deploy`, hosts: [hostId] } },
      verified: { runId: `${runId}:verify`, drifted: [] },
    });
    expect(report.deploy!.apply).not.toHaveProperty("error");
    const applied = await app.client.applyReport(`${runId}:deploy`);
    expect(applied.results).toEqual([expect.objectContaining({ id: hostId, status: "done" })]);
    // The checkout follows main first, so the hosts applied are the merged ones.
    expect(repo.follows.at(-1)).toEqual({ url: remote.url, token: expect.any(String), ref: "main" });
  });
});

describe("a change whose deploy starts the worker again", () => {
  const source = testRepository();
  const root = rootWith({ "resources/infra.ts": testhostInfra(source.url) });
  /**
   * Once, the next start of the host: the worker starts again meanwhile, and that start ends only
   * once it has, its worker gone (the fake takes one start after another, so the next waits for it).
   */
  let cut: (() => void) | undefined;
  const host = fakeHost(async () => {
    const now = cut;
    cut = undefined;
    if (now) {
      now();
      await Promise.all(restarts);
    }
    return { url: "http://127.0.0.1:4100", stop: async () => {} };
  });
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  // The checkout as `localGitSource`'s: at the commit it last followed, so following a merge moves it.
  let checkedOut = "0".repeat(40);
  const moving: Source = {
    ...repo.source,
    head: (ref) => (ref === undefined || ref === "HEAD" ? checkedOut : repo.source.head(ref)),
    async follow(target) {
      const moved = await repo.source.follow!(target);
      if (target.ref === "main" && "revision" in moved) checkedOut = moved.revision;
      return moved;
    },
  };
  /** Each start again the worker was asked, as `sanoma serve`'s reload does it: this worker stopped, a new one started. */
  const restarts: Promise<void>[] = [];
  /** What the worker's `reload` does: start again at once, unless a test says otherwise. */
  let reload = () => void restarts.push(app.restart());
  const databaseUrl = freshDatabase("change-reload");
  const app = useTestApp(
    { workflows: [], connectors: [host.connector, remote.connector], ledger: memoryLedger(), root },
    { databaseUrl, source: moving, reload: () => reload() },
  );
  const pool = lazyDb(databaseUrl, "change reload test");
  beforeAll(() => source.commit());
  afterAll(async () => {
    await host.close();
    source.remove();
    repo.remove();
    await pool.close();
  });

  it("merges, brings the records along, deploys, verifies and closes across the worker starting again", async () => {
    const hostId = "resources/infra.ts#app";
    await app.client.applyReport(await app.client.apply({ only: [hostId] }, { startedBy: "alice" }));
    const db = await pool.db();
    await db
      .insert(data)
      .values([
        { collection: "deals", key: "Acme", record: { company: "Acme", touched: "2026-01-02" }, updatedBy: "leon" },
      ]);
    const plan: TableChangePlan = {
      collection: "deals",
      rows: 1,
      changes: [{ kind: "rename", from: "touched", to: "contacted" }],
    };
    repo.edit("columns", { "notes/columns.md": "\n" });
    const runId = await app.client.openChange({ id: "columns", title: "Columns", plan }, { startedBy: "alice" });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
    const report = (await app.client.result(runId, 60_000)) as ChangeReport;
    expect(restarts).toHaveLength(1);
    await Promise.all(restarts);
    const reshaped = { rows: 1, changed: 1, converted: 0, cleared: 0, kept: 0 };
    expect(report).toMatchObject({
      outcome: "merged",
      reshaped,
      deploy: { follow: { revision: checkedOut }, apply: { runId: `${runId}:deploy`, hosts: [hostId] } },
      verified: { runId: `${runId}:verify`, drifted: [] },
    });
    expect((await app.client.change("columns"))!.state).toMatchObject({ phase: "merged", merged: { reshaped } });
    expect(repo.closed).toContain("columns");
    // Cut short by the stop and taken up by the worker started in its place.
    expect((await app.raw.getWorkflow(runId))?.recoveryAttempts).toBeGreaterThan(1);
    const [row] = await db.select().from(data).where(eq(data.collection, "deals"));
    expect(row!.record).toEqual({ company: "Acme", contacted: "2026-01-02" });
  });

  it("finishes its deploy on another version when the worker starts again during the apply", async () => {
    restarts.length = 0;
    // The merge changes the company's code: the worker started again runs another version, and
    // stops the old one while the apply it started (a child run) is still under way.
    reload = () => {};
    cut = () => {
      process.env.DBOS__APPVERSION = "moved";
      restarts.push(app.restart());
    };
    // Started again from inside the apply's step, the worker carries the runs outside it.
    const warn = vi.spyOn(console, "warn");
    try {
      // The host's source moved on, so the apply starts it again.
      await source.commit();
      repo.edit("moved", { "notes/moved.md": "\n" });
      const runId = await app.client.openChange({ id: "moved", title: "Moved" }, { startedBy: "alice" });
      await waitFor(pending(() => app.client, runId));
      await app.client.decide(runId, { decision: "approve", by: { id: "alice" } });
      const report = (await app.client.result(runId, 60_000)) as ChangeReport;
      await Promise.all(restarts);
      expect(restarts).toHaveLength(1);
      expect(report).toMatchObject({
        outcome: "merged",
        deploy: { apply: { runId: `${runId}:deploy`, hosts: ["resources/infra.ts#app"] } },
        verified: { runId: `${runId}:verify`, drifted: [] },
      });
      expect(report.deploy!.apply).not.toHaveProperty("error");
      // Both carried onto the version started in their place.
      for (const id of [runId, `${runId}:deploy`]) {
        expect((await app.raw.getWorkflow(id))?.applicationVersion).toMatch(/@moved$/);
      }
      expect(warn.mock.calls.flat().join("\n")).not.toMatch(/carrying the built-in runs|retrieveWorkflow/);
    } finally {
      warn.mockRestore();
      delete process.env.DBOS__APPVERSION;
      reload = () => void restarts.push(app.restart());
    }
  }, 90_000);
});

/** `stillMade` of `fields` and `changes`, written as plain data. */
const made = (fields: Record<string, unknown>, changes: unknown[]) =>
  stillMade(fields as Parameters<typeof stillMade>[0], changes as Parameters<typeof stillMade>[1]);

describe("stillMade: whether Try again may replay a plan over the running declaration", () => {
  it("takes a rename's new name declared and its old one not", () => {
    const rename = [{ kind: "rename", from: "touched", to: "contacted" }];
    expect(made({ contacted: "text" }, rename)).toBe(true);
    expect(made({ contacted: "text", touched: "text" }, rename)).toBe(false);
    expect(made({ touched: "text" }, rename)).toBe(false);
    // Renamed, then retyped under its new name: judged by the last change that made it.
    const renamedTyped = [...rename, { kind: "retype", field: "contacted", to: "date" }];
    expect(made({ contacted: "date" }, renamedTyped)).toBe(true);
    expect(made({ contacted: "text" }, renamedTyped)).toBe(false);
  });

  it("takes a retyped field of its new type, hidden or shown, and a link to the same collection", () => {
    const toNumber = [{ kind: "retype", field: "seats", to: "number" }];
    expect(made({ seats: "number" }, toNumber)).toBe(true);
    expect(made({ seats: { type: "number", optional: true, hidden: true } }, toNumber)).toBe(true);
    expect(made({ seats: "text" }, toNumber)).toBe(false);
    expect(made({}, toNumber)).toBe(false);
    const toLink = [{ kind: "retype", field: "customer", to: { link: "accounts" } }];
    expect(made({ customer: { link: "accounts", optional: true } }, toLink)).toBe(true);
    expect(made({ customer: { link: "vendors" } }, toLink)).toBe(false);
    expect(made({ customer: "text" }, toLink)).toBe(false);
    const toChoice = [{ kind: "retype", field: "stage", to: { enum: ["new", "won"] } }];
    expect(made({ stage: { enum: ["new", "won"] } }, toChoice)).toBe(true);
    expect(made({ stage: { enum: ["new", "lost"] } }, toChoice)).toBe(false);
  });

  it("takes a conversion's new column of its type, out of a field free-form still", () => {
    const convert = [{ kind: "convert", field: "meta", key: "seats", to: "count", type: "number" }];
    expect(made({ meta: { type: "json", optional: true }, count: { type: "number", optional: true } }, convert)).toBe(
      true,
    );
    expect(made({ meta: "json" }, convert)).toBe(false);
    expect(made({ meta: "json", count: "text" }, convert)).toBe(false);
    expect(made({ meta: "text", count: "number" }, convert)).toBe(false);
    // Its key's name is no column of it: only the new name counts.
    expect(made({ meta: "json", count: "number", seats: "text" }, convert)).toBe(true);
  });

  it("takes a removed field undeclared: one declared again since, of any type, would lose its values", () => {
    const remove = [{ kind: "remove", field: "legacy" }];
    expect(made({ company: "text" }, remove)).toBe(true);
    expect(made({ company: "text", legacy: { type: "text", optional: true, hidden: true } }, remove)).toBe(false);
    expect(made({ company: "text", legacy: "number" }, remove)).toBe(false);
  });
});
