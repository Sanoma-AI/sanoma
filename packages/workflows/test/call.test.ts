import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  defineConnector,
  defineDriver,
  definePolicy,
  defineWorkflow,
  deny,
  DriverError,
  errorCode,
  type LedgerRecord,
  type LedgerStore,
  memoryLedger,
  type PolicyCall,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("call");
const alice = { id: "alice" };
const types = (records: LedgerRecord[]) => records.map((r) => (r.type === "op.called" ? `${r.type} ${r.op}` : r.type));
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (e: unknown) => e,
  );

/** One post: bluesky.post.create is not idempotent, so it is never retried. */
const post = defineWorkflow({
  name: "post",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
  run: async (ctx, { text }) => ctx.bluesky.post.create({ text }),
});

/** A draft, then publishing it: ghost.post.publish is idempotent, so DBOS retries it. */
const publish = defineWorkflow({
  name: "publish",
  trigger: "manual",
  input: z.object({ title: z.string() }),
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, { title }) => {
    const draft = await ctx.ghost.post.create({ title, html: "<p>x</p>" });
    return ctx.ghost.post.publish({ id: draft.id });
  },
});

/** Calls an operation with input its connector's schema refuses. */
const sloppy = defineWorkflow({
  name: "sloppy",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create],
  run: async (ctx) => ctx.bluesky.post.create({ text: 42 } as never),
});

const nap = defineWorkflow({
  name: "nap",
  trigger: "manual",
  input: z.object({ request: z.any() }),
  uses: ["sleep"],
  run: async (ctx, { request }) => {
    await ctx.sleep(request);
    return "rested";
  },
});

/** A connector whose operation names the note it acts on, for the policy. */
const notes = defineConnector("notes", {
  note: {
    update: {
      effect: "write",
      idempotent: true,
      input: z.object({ id: z.string(), text: z.string() }),
      output: z.object({ id: z.string() }),
      target: ({ id }) => `note/${id}`,
    },
  },
});
const notesDriver = defineDriver(notes, { note: { update: async ({ id }) => ({ id }) } });
const edit = defineWorkflow({
  name: "edit",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [notes.note.update],
  run: async (ctx, { id }) => ctx.notes.note.update({ id, text: "hi" }),
});

describe("a call that fails", () => {
  const app = useApp(databaseUrl, "call-driver", () => ({ workflows: [post, publish, sloppy] }));
  const c = () => app.client;

  it("fails the run with invalid_input, naming the operation, when the input fails its schema", async () => {
    const runId = await c().start(sloppy, {}, { startedBy: alice });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("invalid_input");
    expect(err).toMatchObject({
      message: expect.stringMatching(/^The input to bluesky\.post\.create does not match its schema: text: /),
      data: { op: "bluesky.post.create", issues: [expect.objectContaining({ path: ["text"] })] },
    });
    expect(app.ops()).toEqual([]);
    const records = await c().ledger(runId);
    expect(types(records)).toEqual(["run.started", "run.failed"]);
    expect(records.at(-1)).toMatchObject({ error: { code: "invalid_input", name: "SanomaError" } });
  });

  it("fails the run with driver_failed when a non-idempotent call loses its reply, after one side effect", async () => {
    app.vendors.bluesky.loseReply("bluesky.post.create");
    const runId = await c().start(post, { text: "lost" }, { startedBy: alice });

    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("driver_failed");
    // DBOS hands the run's error back as a copy: the code must be an own enumerable property.
    expect(Object.keys(err as object)).toContain("code");
    expect(err).toMatchObject({ message: "fake bluesky: the reply to bluesky.post.create was lost" });
    expect(app.ops()).toEqual(["bluesky.post.create"]);
    expect(app.vendors.bluesky.state.posts).toHaveLength(1);

    const records = await c().ledger(runId);
    const vendorError = { code: "driver_failed", name: "DriverError", message: expect.stringMatching(/was lost/) };
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "bluesky.post.create",
      attempt: 1,
      error: vendorError,
    });
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: vendorError });
  });

  it("does not retry an idempotent call when the driver says the answer is final", async () => {
    const locked = new DriverError("ghost: the post is locked", { retryable: false, status: 409 });
    app.vendors.ghost.failNext("ghost.post.publish", locked);
    const runId = await c().start(publish, { title: "Locked" }, { startedBy: alice });

    expect(errorCode(await failure(c().result(runId)))).toBe("driver_failed");
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish"]);
    expect((await c().ledger(runId)).at(-2)).toMatchObject({
      op: "ghost.post.publish",
      attempt: 1,
      error: { code: "driver_failed", name: "DriverError", message: "ghost: the post is locked" },
    });
  });

  it("retries an idempotent call the driver says may succeed, and records the try that did", async () => {
    app.vendors.ghost.failNext("ghost.post.publish", new DriverError("ghost: 503", { retryable: true, status: 503 }));
    const runId = await c().start(publish, { title: "Flaky" }, { startedBy: alice });

    expect(await c().result(runId)).toMatchObject({ status: "published" });
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish", "ghost.post.publish"]);
    const call = (await c().ledger(runId)).at(-2);
    expect(call).toMatchObject({ op: "ghost.post.publish", attempt: 2, output: { status: "published" } });
    expect(call).not.toHaveProperty("error");
  });

  it("retries an idempotent call that was rate limited", async () => {
    app.vendors.ghost.rateLimit("ghost.post.publish");
    const runId = await c().start(publish, { title: "Busy" }, { startedBy: alice });

    expect(await c().result(runId)).toMatchObject({ status: "published" });
    const calls = app.vendors.calls.filter((call) => call.op === "ghost.post.publish");
    expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect((await c().ledger(runId)).at(-2)).toMatchObject({ op: "ghost.post.publish", attempt: 2 });
  });

  it("records the vendor's last error, not DBOS's wrapper, when the tries run out", async () => {
    for (const n of [1, 2, 3]) {
      app.vendors.ghost.failNext("ghost.post.publish", new DriverError(`ghost: 503 (${n})`, { retryable: true }));
    }
    const runId = await c().start(publish, { title: "Down" }, { startedBy: alice });

    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("driver_failed");
    expect(err).toMatchObject({ name: "DriverError", message: "ghost: 503 (3)" });
    expect(app.ops().filter((op) => op === "ghost.post.publish")).toHaveLength(3);
    const records = await c().ledger(runId);
    const last = { code: "driver_failed", name: "DriverError", message: "ghost: 503 (3)" };
    expect(records.at(-2)).toMatchObject({ op: "ghost.post.publish", attempt: 3, error: last });
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: last });
  });
});

describe("a worker restarted mid-run", () => {
  const app = useApp(databaseUrl, "call-restart", () => ({ workflows: [announce, post] }));
  const c = () => app.client;

  it("does not repeat a call the stopped worker was making: the recovered call reuses its idempotency key", async () => {
    const release = app.vendors.bluesky.hold("bluesky.post.create");
    const runId = await c().start(post, { text: "once" }, { startedBy: alice });
    await waitFor(() => app.ops().length === 1);

    // The call is in flight at the vendor when the worker stops; the next worker recovers the run.
    await app.restart();
    await waitFor(() => app.ops().length === 2);
    release();

    expect(await c().result(runId)).toMatchObject({ url: expect.any(String) });
    const [first, again] = app.vendors.calls;
    expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["once"]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "op.called bluesky.post.create", "run.finished"]);
  });

  it("keeps waiting for an approval across a restart, and records each step once", async () => {
    const runId = await c().start(
      announce,
      { title: "Restarted", body: "<p>x</p>", launchAt: inSeconds(-1) },
      { startedBy: alice },
    );
    await waitFor(pending(c, runId));
    await app.restart();

    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "ghost.post.publish",
      "resend.broadcast.send",
      "bluesky.post.create",
    ]);
    const records = await c().ledger(runId);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "approval.requested",
      "approval.decided",
      "op.called ghost.post.publish",
      "op.called resend.broadcast.send",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
  });
});

describe("ctx.sleep", () => {
  const app = useApp(databaseUrl, "call-sleep", () => ({ workflows: [nap] }));
  const c = () => app.client;
  const steps = async (runId: string) => ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);

  it("fails the run with invalid_input, before any DBOS call, on a request it can't read", async () => {
    const bad: [unknown, RegExp][] = [
      [{ until: "tomorrow" }, /until: must be an ISO 8601 date-time with an offset/],
      [{ until: "2026-10-07T09:00:00" }, /until: must be an ISO 8601 date-time with an offset/],
      [{ seconds: -1 }, /seconds: must not be negative/],
      [{ second: 5 }, /Unrecognized key: "second"/],
    ];
    // Started together: the runs are independent, and waiting on each in turn is slow.
    const runs = await Promise.all(bad.map(([request]) => c().start(nap, { request }, { startedBy: alice })));
    for (const [i, runId] of runs.entries()) {
      const [request, message] = bad[i]!;
      const err = await failure(c().result(runId));
      expect(errorCode(err), JSON.stringify(request)).toBe("invalid_input");
      expect(err).toMatchObject({ message: expect.stringMatching(message) });
      expect(await steps(runId)).toEqual([]);
      expect((await c().ledger(runId)).at(-1)).toMatchObject({ type: "run.failed", error: { code: "invalid_input" } });
    }
  });

  it("does not wait, or add a sleep step, for a time already past", async () => {
    const requests = [{ until: "2020-01-01T00:00:00Z" }, { until: 0 }, { ms: 200 }];
    const [isoPast, epochPast, short] = await Promise.all(
      requests.map((request) => c().start(nap, { request }, { startedBy: alice })),
    );
    for (const runId of [isoPast!, epochPast!]) {
      expect(await c().result(runId)).toBe("rested");
      expect(await steps(runId)).toEqual(["DBOS.now"]);
      expect(types(await c().ledger(runId))).toEqual(["run.started", "run.finished"]);
    }
    expect(await c().result(short!)).toBe("rested");
    expect(await steps(short!)).toEqual(["DBOS.sleep"]);
  });
});

describe("the call a policy sees", () => {
  const seen: PolicyCall[] = [];
  const policy = definePolicy(
    (call) => {
      // A copy proves the call is plain data: structuredClone refuses functions such as zod schemas.
      seen.push(structuredClone(call));
      return call.target === "note/locked"
        ? deny("the note is locked", ["note/locked is read-only"])
        : allow([`${call.op.id} may change ${call.target ?? "anything"}`]);
    },
    { version: "notes-1" },
  );
  const app = useApp(databaseUrl, "call-policy", (vendors) => ({
    workflows: [edit, post],
    connectors: [ghost, resend, bluesky, notes],
    drivers: [...vendors.drivers, notesDriver],
    policy,
    ledger: memoryLedger(),
  }));
  const c = () => app.client;

  it("is plain data with the operation's target, and its reasons are recorded with the policy's version", async () => {
    seen.length = 0;
    const runId = await c().start(edit, { id: "n1" }, { startedBy: alice });
    expect(await c().result(runId)).toEqual({ id: "n1" });
    expect(seen).toEqual([
      {
        op: { id: "notes.note.update", vendor: "notes", resource: "note", name: "update", effect: "write" },
        effect: "write",
        target: "note/n1",
        input: { id: "n1", text: "hi" },
        actor: alice,
        run: { id: runId, workflow: "edit", approvals: [] },
      },
    ]);
    expect((await c().ledger(runId)).at(-2)).toMatchObject({
      op: "notes.note.update",
      decision: { kind: "allow", reasons: ["notes.note.update may change note/n1"], policyVersion: "notes-1" },
    });

    const denied = await c().start(edit, { id: "locked" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(denied)))).toBe("policy_denied");
    expect((await c().ledger(denied)).at(-2)).toMatchObject({
      decision: {
        kind: "deny",
        reason: "the note is locked",
        reasons: ["note/locked is read-only"],
        policyVersion: "notes-1",
      },
    });
  });

  it("has no target when the operation declares none", async () => {
    seen.length = 0;
    const runId = await c().start(post, { text: "hi" }, { startedBy: alice });
    await c().result(runId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("target");
    expect(seen[0]?.op).toEqual({
      id: "bluesky.post.create",
      vendor: "bluesky",
      resource: "post",
      name: "create",
      effect: "publish",
    });
  });
});

describe("a call queued behind a refused one", () => {
  // Both calls are made at once; the publish is refused, which ends the run.
  const both = defineWorkflow({
    name: "both",
    trigger: "manual",
    input: z.object({ id: z.string() }),
    uses: [ghost.post.publish, bluesky.post.create],
    run: async (ctx, { id }) => Promise.all([ctx.ghost.post.publish({ id }), ctx.bluesky.post.create({ text: "too" })]),
  });
  const policy = definePolicy(({ op }) => (op.id === "ghost.post.publish" ? deny("not today") : allow()));
  const app = useApp(databaseUrl, "call-ended", () => ({ workflows: [both], policy }));
  const c = () => app.client;

  it("never reaches its vendor once the run has failed", async () => {
    const runId = await c().start(both, { id: "p1" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    // Time for the queued call to run, had it been going to.
    await new Promise((r) => setTimeout(r, 300));

    // Its policy step may have run (a decision, no side effect), but never the vendor's step.
    const steps = ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);
    expect(steps).not.toContain("bluesky.post.create");
    expect(app.ops()).toEqual([]);
    expect(app.vendors.bluesky.state.posts).toEqual([]);
    const records = await c().ledger(runId);
    expect(records.some((r) => r.type === "op.called" && r.op === "bluesky.post.create" && "output" in r)).toBe(false);
    expect(types(records)).toEqual(["run.started", "op.called ghost.post.publish", "run.failed"]);
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: { code: "policy_denied" } });
  });
});

describe("a ledger store that fails for a while", () => {
  // Each record's first two appends fail; the third succeeds.
  const store = memoryLedger();
  const appends = new Map<string, number>();
  const flaky: LedgerStore = {
    read: (runId) => store.read(runId),
    async append(record) {
      const n = (appends.get(record.id) ?? 0) + 1;
      appends.set(record.id, n);
      if (n <= 2) throw new Error(`ledger busy (${n})`);
      await store.append(record);
    },
  };
  const app = useApp(databaseUrl, "call-ledger", () => ({ workflows: [publish], ledger: flaky }));
  const c = () => app.client;

  it("does not fail the run, and keeps one record per id", async () => {
    const runId = await c().start(publish, { title: "Retried" }, { startedBy: alice });
    expect(await c().result(runId)).toMatchObject({ status: "published" });
    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called ghost.post.publish",
      "run.finished",
    ]);
    expect(records.map((r) => appends.get(r.id))).toEqual([3, 3, 3, 3]);
  });
});
