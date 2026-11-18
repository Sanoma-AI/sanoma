import { bluesky } from "@sanoma-ai/connector-bluesky";
import { ghost } from "@sanoma-ai/connector-ghost";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, defineWorkflow, errorCode, type LedgerRecord } from "../src/index.ts";
import score from "./fixtures/company-apps/apps/crm/operations/score.ts";
import { customers as crmCustomers } from "./fixtures/company-apps/apps/crm/resources/data.ts";
import { failure, pending, rootWith, types, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.

/** Drafts a post and publishes it: the company's own operation, `operations.release.run`. */
const release = defineOperation({
  name: "release",
  description: "Drafts a post and publishes it",
  input: z.object({ title: z.string() }),
  output: z.object({ id: z.string(), url: z.string() }),
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, { title }) => {
    const draft = await ctx.ghost.post.create({ title, html: "<p>x</p>" });
    const published = await ctx.ghost.post.publish({ id: draft.id });
    return { id: published.id, url: published.url };
  },
});

/** The operation as a step, then a post of its own. */
const launch = defineWorkflow({
  name: "launch",
  trigger: "manual",
  input: z.object({ title: z.string() }),
  uses: [release, bluesky.post.create],
  run: async (ctx, { title }) => {
    const released = await ctx.operations.release.run({ title });
    await ctx.bluesky.post.create({ text: released.url });
    return released.id;
  },
});

/** Reaches ctx without naming it, which the outline cannot see: the run's own check catches the call. */
const sneaky = defineOperation({
  name: "sneaky",
  input: z.object({ title: z.string() }),
  uses: [ghost.post.create],
  async run(ctx, { title }) {
    const c = arguments[0] as typeof ctx;
    return c.ghost.post.create({ title, html: "" });
  },
});

/** Two releases side by side: each operation's calls are recorded within it, in its member. */
const both = defineWorkflow({
  name: "both",
  trigger: "manual",
  input: z.object({}),
  uses: [release, "all"],
  run: async (ctx) =>
    ctx.all([() => ctx.operations.release.run({ title: "a" }), () => ctx.operations.release.run({ title: "b" })]),
});

const sneaking = defineWorkflow({
  name: "sneaking",
  trigger: "manual",
  input: z.object({}),
  uses: [sneaky],
  run: async (ctx) => ctx.operations.sneaky.run({ title: "x" }),
});

// careful's publishes are held for the lead, and wary's releases; blocked may not publish; barred may not release.
const root = rootWith({
  "policies/policy.cedar": `@hold("lead")
forbid (principal == Sanoma::Principal::"careful", action == Sanoma::Action::"ghost.post.publish", resource);

@hold("lead")
forbid (principal == Sanoma::Principal::"wary", action == Sanoma::Action::"operations.release.run", resource);

@reason("blocked may not publish")
forbid (principal == Sanoma::Principal::"blocked", action == Sanoma::Action::"ghost.post.publish", resource);

@reason("barred may not release")
forbid (principal == Sanoma::Principal::"barred", action == Sanoma::Action::"operations.release.run", resource);
`,
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const careful = sanoma.person({ id: "careful" });
export const wary = sanoma.person({ id: "wary" });
export const blocked = sanoma.person({ id: "blocked" });
export const barred = sanoma.person({ id: "barred" });
export const lead = sanoma.person({ id: "lead" });
`,
});

const calls = (records: LedgerRecord[]) =>
  records.flatMap((r) => (r.type === "op.called" ? [{ op: r.op, seq: r.seq, node: r.node, within: r.within }] : []));

describe("a company operation in a run", () => {
  const app = useApp("operations", () => ({
    workflows: [launch, both, sneaking],
    operations: [release, sneaky],
    root,
  }));
  const c = () => app.client;
  const steps = async (runId: string) => ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);

  it("runs inline, each call it makes its own step under the operation's node, recorded within it", async () => {
    const runId = await c().start(launch, { title: "Launch" }, { startedBy: { id: "alice" } });
    const id = await c().result(runId);
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish", "bluesky.post.create"]);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called operations.release.run",
      "op.called ghost.post.create",
      "op.called ghost.post.publish",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    // The operation takes its seq before its calls, and records once they are done.
    expect(calls(records)).toEqual([
      { op: "operations.release.run", seq: 1, node: "0", within: undefined },
      { op: "ghost.post.create", seq: 2, node: "0.0.0", within: 1 },
      { op: "ghost.post.publish", seq: 3, node: "0.0.1", within: 1 },
      { op: "bluesky.post.create", seq: 4, node: "1", within: undefined },
    ]);
    expect(records[1]).toMatchObject({
      input: { title: "Launch" },
      output: { id, url: expect.any(String) },
      decision: { kind: "allow" },
    });
    // The operation's own step is its decision; each call inside has its own steps.
    expect(await steps(runId)).toEqual([
      "policy:operations.release.run",
      "connection:ghost.post.create",
      "policy:ghost.post.create",
      "ghost.post.create",
      "connection:ghost.post.publish",
      "policy:ghost.post.publish",
      "ghost.post.publish",
      "connection:bluesky.post.create",
      "policy:bluesky.post.create",
      "bluesky.post.create",
    ]);
  });

  it("is held as an operation: none of its calls is made until the hold is approved", async () => {
    const runId = await c().start(launch, { title: "Wary" }, { startedBy: { id: "wary" } });
    await waitFor(pending(c, runId));
    expect(app.ops()).toEqual([]);
    await c().decide(runId, { decision: "approve", by: { id: "lead" } });
    await c().result(runId);
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish", "bluesky.post.create"]);
    expect(types(await c().ledger(runId))).toEqual([
      "run.started",
      "op.called operations.release.run",
      "approval.requested",
      "approval.decided",
      "op.called ghost.post.create",
      "op.called ghost.post.publish",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
  });

  it("runs as a ctx.all member, its calls in the member, each recorded within its own operation's call", async () => {
    const runId = await c().start(both, {}, { startedBy: { id: "alice" } });
    await c().result(runId);
    const records = (await c().ledger(runId)).filter((r) => r.type === "op.called");
    expect(records.map((r) => [r.op, r.seq, r.node, r.within, r.group?.index])).toEqual([
      ["operations.release.run", 1, "0.0.0", undefined, 0],
      ["ghost.post.create", 2, "0.0.0.0.0", 1, 0],
      ["ghost.post.publish", 3, "0.0.0.0.1", 1, 0],
      ["operations.release.run", 4, "0.1.0", undefined, 1],
      ["ghost.post.create", 5, "0.1.0.0.0", 4, 1],
      ["ghost.post.publish", 6, "0.1.0.0.1", 4, 1],
    ]);
  });

  it("refuses a call its outline could not see coming, naming the operation", async () => {
    const runId = await c().start(sneaking, {}, { startedBy: { id: "alice" } });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("call_not_in_outline");
    expect((err as Error).message).toMatch(
      /^ctx\.ghost\.post\.create was called from .*operations\.test\.ts:\d+:\d+, which is no ctx call in operations\.sneaky\.run's outline/,
    );
    expect(app.ops()).toEqual([]);
  });

  it("is decided as an operation: a denied one makes none of its calls", async () => {
    const runId = await c().start(launch, { title: "No" }, { startedBy: { id: "barred" } });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    expect(app.ops()).toEqual([]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "op.called operations.release.run", "run.failed"]);
  });

  it("fails with the call it made that failed, recorded within it, and records its own failure", async () => {
    const runId = await c().start(launch, { title: "Blocked" }, { startedBy: { id: "blocked" } });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    expect(app.ops()).toEqual(["ghost.post.create"]);
    const records = await c().ledger(runId);
    expect(calls(records)).toEqual([
      { op: "operations.release.run", seq: 1, node: "0", within: undefined },
      { op: "ghost.post.create", seq: 2, node: "0.0.0", within: 1 },
      { op: "ghost.post.publish", seq: 3, node: "0.0.1", within: 1 },
    ]);
    expect(records.find((r) => r.type === "op.called" && r.op === "ghost.post.publish")).toMatchObject({
      decision: { kind: "deny", reason: "blocked may not publish" },
    });
    expect(records[1]).toMatchObject({ error: { code: "policy_denied" } });
    expect(records.at(-1)!.type).toBe("run.failed");
  });

  it("holds a call it makes for approval across a restart, and makes each call once", async () => {
    const runId = await c().start(launch, { title: "Held" }, { startedBy: { id: "careful" } });
    await waitFor(pending(c, runId));
    expect(app.ops()).toEqual(["ghost.post.create"]);
    await app.restart();

    await c().decide(runId, { decision: "approve", by: { id: "lead" } });
    await c().result(runId);
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish", "bluesky.post.create"]);
    const records = await c().ledger(runId);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    // The held call takes its seq before the approval it waits for, as a workflow's does.
    expect(types(records)).toEqual([
      "run.started",
      "op.called operations.release.run",
      "op.called ghost.post.create",
      "op.called ghost.post.publish",
      "approval.requested",
      "approval.decided",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(records.find((r) => r.type === "approval.requested")).toMatchObject({ within: 1 });
  });
});

// An app's operation, `operations.crm.score.run`: four names, which the built-in call workflow reaches.
const appRoot = rootWith({
  "policies/policy.cedar": `@hold("lead")
forbid (principal, action == Sanoma::Action::"operations.crm.score.run", resource);
`,
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const lead = sanoma.person({ id: "lead" });
`,
});

describe("a company operation called directly and held", () => {
  const app = useApp("operations-direct", () => ({
    workflows: [],
    operations: [score],
    collections: [crmCustomers],
    root: appRoot,
  }));
  const c = () => app.client;

  it("is made by a run of call once approved, an app's operation by its four names", async () => {
    const id = randomUUID();
    const runId = `call:alice:${id}`;
    const call = () => c().call("operations.crm.score.run", { email: "ada@acme.test" }, { actor: "alice", id });
    expect(await failure(call())).toMatchObject({ code: "approval_pending", data: { runId } });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "lead" } });
    expect(await c().result(runId)).toEqual({ score: 0 });
    expect(types(await c().ledger(runId))).toEqual([
      "run.started",
      "op.called operations.crm.score.run",
      "approval.requested",
      "approval.decided",
      "op.called data.crm.customers.get",
      "run.finished",
    ]);
    expect(await call()).toEqual({ score: 0 });
  });
});
