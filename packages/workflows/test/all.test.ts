import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow, errorCode, type LedgerRecord } from "../src/index.ts";
import { pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("all");
const alice = { id: "alice" };
const types = (records: LedgerRecord[]) => records.map((r) => (r.type === "op.called" ? `${r.type} ${r.op}` : r.type));
const groups = (records: LedgerRecord[]) => records.map((r) => r.group);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (e: unknown) => e,
  );

/** A post before and after a fan-out of two posts and a draft. */
const fan = defineWorkflow({
  name: "fan",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create, ghost.post.create, "all"],
  run: async (ctx) => {
    await ctx.bluesky.post.create({ text: "before" });
    const [one, two, draft] = await ctx.all([
      () => ctx.bluesky.post.create({ text: "one" }),
      () => ctx.bluesky.post.create({ text: "two" }),
      () => ctx.ghost.post.create({ title: "Three", html: "<p>3</p>", status: "draft" }),
    ]);
    await ctx.bluesky.post.create({ text: "after" });
    return [one.url, two.url, draft.status];
  },
});

/** An approval as one member, a post as the other. */
const signed = defineWorkflow({
  name: "signed",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create, "approval", "all"],
  run: async (ctx) => {
    const [, posted] = await ctx.all([
      () => ctx.approval("Post it?", { approver: "marketing-lead" }),
      () => ctx.bluesky.post.create({ text: "signed" }),
    ]);
    return posted.url;
  },
});

/** The second member fails for good: ghost has no such post. */
const broken = defineWorkflow({
  name: "broken",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create, ghost.post.publish, "all"],
  run: async (ctx) =>
    ctx.all([
      () => ctx.bluesky.post.create({ text: "first" }),
      () => ctx.ghost.post.publish({ id: "post_missing" }),
      () => ctx.bluesky.post.create({ text: "never" }),
    ]),
});

/** Calls ctx.all with what the request says, so a test can send one it must refuse. */
const odd = defineWorkflow({
  name: "odd",
  trigger: "manual",
  input: z.object({ shape: z.enum(["nested", "empty", "not-a-list", "not-functions"]) }),
  uses: ["all"],
  run: async (ctx, { shape }) => {
    if (shape === "nested") return ctx.all([async () => "outer", () => ctx.all([async () => "inner"])]);
    if (shape === "empty") return ctx.all([]);
    if (shape === "not-a-list") return ctx.all("members" as never);
    return ctx.all([1, 2] as never);
  },
});

describe("ctx.all", () => {
  const app = useApp(databaseUrl, "all", () => ({ workflows: [fan, signed, broken, odd] }));
  const c = () => app.client;

  it("runs the members in order, returns their outputs in order, and tags their records with the group", async () => {
    const runId = await c().start(fan, {}, { startedBy: alice });
    expect(await c().result(runId)).toEqual([expect.any(String), expect.any(String), "draft"]);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["before", "one", "two", "after"]);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called bluesky.post.create",
      "op.called bluesky.post.create",
      "op.called bluesky.post.create",
      "op.called ghost.post.create",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(groups(records)).toEqual([
      undefined,
      undefined,
      { id: "all:0", index: 0, size: 3 },
      { id: "all:0", index: 1, size: 3 },
      { id: "all:0", index: 2, size: 3 },
      undefined,
      undefined,
    ]);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
  });

  it("tags the records of an approval a member asks for", async () => {
    const runId = await c().start(signed, {}, { startedBy: alice });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "approval.requested",
      "approval.decided",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    const group = { id: "all:0", size: 2 };
    expect(groups(records)).toEqual([
      undefined,
      { ...group, index: 0 },
      { ...group, index: 0 },
      { ...group, index: 1 },
      undefined,
    ]);
  });

  it("stops at the first member that fails, with its error, and never runs the members after it", async () => {
    const runId = await c().start(broken, {}, { startedBy: alice });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("driver_failed");
    expect(app.ops()).toEqual(["bluesky.post.create", "ghost.post.publish"]);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["first"]);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called bluesky.post.create",
      "op.called ghost.post.publish",
      "run.failed",
    ]);
    expect(records[2]).toMatchObject({ group: { id: "all:0", index: 1, size: 3 }, error: { code: "driver_failed" } });
    expect(records[3]).not.toHaveProperty("group");
  });

  it("refuses a nested ctx.all, and an argument that is not a list of functions, with invalid_input", async () => {
    const shapes = ["nested", "not-a-list", "not-functions"] as const;
    const runs = await Promise.all(shapes.map((shape) => c().start(odd, { shape }, { startedBy: alice })));
    const errors = await Promise.all(runs.map((runId) => failure(c().result(runId))));
    expect(errors.map(errorCode)).toEqual(["invalid_input", "invalid_input", "invalid_input"]);
    expect(errors[0]).toMatchObject({ message: expect.stringMatching(/^ctx\.all cannot be nested/) });
    expect(errors[1]).toMatchObject({ message: expect.stringMatching(/^ctx\.all: needs a list of functions/) });
    expect(errors[2]).toMatchObject({ message: expect.stringMatching(/^ctx\.all: 0: each member must be a function/) });
  });

  it("returns [] for no members, and writes nothing for them", async () => {
    const runId = await c().start(odd, { shape: "empty" }, { startedBy: alice });
    expect(await c().result(runId)).toEqual([]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "run.finished"]);
  });

  it("replays the members a stopped worker finished, and runs the one it was in once", async () => {
    const release = app.vendors.ghost.hold("ghost.post.create");
    const runId = await c().start(fan, {}, { startedBy: alice });
    await waitFor(() => app.ops().includes("ghost.post.create"));

    await app.restart();
    await waitFor(() => app.ops().filter((op) => op === "ghost.post.create").length === 2);
    release();

    expect(await c().result(runId)).toHaveLength(3);
    // Members 1 and 2 came back from their recorded steps; member 3 was called again with its key.
    expect(app.ops()).toEqual([
      "bluesky.post.create",
      "bluesky.post.create",
      "bluesky.post.create",
      "ghost.post.create",
      "ghost.post.create",
      "bluesky.post.create",
    ]);
    const drafts = app.vendors.calls.filter((call) => call.op === "ghost.post.create");
    expect(drafts[1]?.idempotencyKey).toBe(drafts[0]?.idempotencyKey);
    expect(Object.keys(app.vendors.ghost.state.posts)).toHaveLength(1);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["before", "one", "two", "after"]);

    const records = await c().ledger(runId);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(types(records)).toEqual([
      "run.started",
      "op.called bluesky.post.create",
      "op.called bluesky.post.create",
      "op.called bluesky.post.create",
      "op.called ghost.post.create",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(records[4]).toMatchObject({ group: { id: "all:0", index: 2, size: 3 } });
  });
});
