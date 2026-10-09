import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it, vi } from "vitest";
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
  policyOpOf,
  SanomaError,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import fanout, { fakeStats, stats } from "./fixtures/fanout.ts";
import { failure, inSeconds, pending, types, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("call");
const alice = { id: "alice" };
const groups = (records: LedgerRecord[]) => records.map((r) => r.group);

/** One post to Bluesky. */
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
/** Names its target with a number, which the runtime refuses. */
const tags = defineConnector("tags", {
  tag: {
    add: {
      effect: "write",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      target: ({ id }: { id: string }) => id.length as unknown as string,
    },
  },
});
const notesDriver = defineDriver(notes, { note: { update: async ({ id }) => ({ id }) } });
const tagsDriver = defineDriver(tags, { tag: { add: async ({ id }) => ({ id }) } });
const tag = defineWorkflow({
  name: "tag",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [tags.tag.add],
  run: async (ctx, { id }) => ctx.tags.tag.add({ id }),
});
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
    expect(records.at(-1)).toMatchObject({
      error: {
        code: "invalid_input",
        name: "SanomaError",
        data: { op: "bluesky.post.create", issues: [expect.objectContaining({ path: ["text"] })] },
      },
    });
  });

  it("fails the run with driver_failed when a non-idempotent call loses its reply, after one side effect", async () => {
    // ghost.post.create is not idempotent, so it is never retried.
    app.vendors.ghost.loseReply("ghost.post.create");
    const runId = await c().start(publish, { title: "lost" }, { startedBy: alice });

    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("driver_failed");
    // DBOS hands the run's error back as a copy: the code must be an own enumerable property.
    expect(Object.keys(err as object)).toContain("code");
    expect(err).toMatchObject({ message: "fake ghost: the reply to ghost.post.create was lost" });
    expect(app.ops()).toEqual(["ghost.post.create"]);
    expect(Object.values(app.vendors.ghost.state.posts)).toHaveLength(1);

    const records = await c().ledger(runId);
    const vendorError = { code: "driver_failed", name: "DriverError", message: expect.stringMatching(/was lost/) };
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "ghost.post.create",
      attempt: 1,
      error: vendorError,
    });
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: vendorError });
  });

  it("records a vendor's failure even when its message reads like DBOS shutting down", async () => {
    const pool = new DriverError("Cannot use a pool after calling end on the pool", { retryable: false });
    app.vendors.bluesky.failNext("bluesky.post.create", pool);
    const runId = await c().start(post, { text: "pool" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(runId)))).toBe("driver_failed");
    const records = await c().ledger(runId);
    expect(types(records)).toEqual(["run.started", "op.called bluesky.post.create", "run.failed"]);
    const said = { code: "driver_failed", message: "Cannot use a pool after calling end on the pool" };
    expect(records[1]).toMatchObject({ error: said });
    expect(records[2]).toMatchObject({ error: said });
  });

  it("does not retry an idempotent call when the driver says the answer is final", async () => {
    const locked = new DriverError("ghost: the post is locked", {
      retryable: false,
      status: 409,
      vendorCode: "locked",
    });
    app.vendors.ghost.failNext("ghost.post.publish", locked);
    const runId = await c().start(publish, { title: "Locked" }, { startedBy: alice });

    expect(errorCode(await failure(c().result(runId)))).toBe("driver_failed");
    expect(app.ops()).toEqual(["ghost.post.create", "ghost.post.publish"]);
    expect((await c().ledger(runId)).at(-2)).toMatchObject({
      op: "ghost.post.publish",
      attempt: 1,
      error: {
        code: "driver_failed",
        name: "DriverError",
        message: "ghost: the post is locked",
        status: 409,
        vendorCode: "locked",
        retryable: false,
      },
    });
    // The run's error is DBOS's copy of the driver's: it keeps them too.
    expect((await c().ledger(runId)).at(-1)).toMatchObject({
      type: "run.failed",
      error: { status: 409, vendorCode: "locked", retryable: false },
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

  it("retries a post whose reply was lost, and posts once", async () => {
    app.vendors.bluesky.loseReply("bluesky.post.create");
    const runId = await c().start(post, { text: "once" }, { startedBy: alice });

    expect(await c().result(runId)).toMatchObject({ uri: expect.any(String) });
    expect(app.ops()).toEqual(["bluesky.post.create", "bluesky.post.create"]);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["once"]);
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

/** Tries the post again when the first call fails. */
const repost = defineWorkflow({
  name: "repost",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create],
  run: async (ctx) => {
    try {
      return await ctx.bluesky.post.create({ text: "once" });
    } catch {
      return ctx.bluesky.post.create({ text: "again" });
    }
  },
});

describe("a call the ledger cannot record", () => {
  // Records each run's start, then refuses everything after it, for good.
  const kept = memoryLedger();
  const full: LedgerStore = {
    read: kept.read,
    async append(record) {
      if (record.type !== "run.started") throw Object.assign(new Error("disk full"), { retryable: false });
      await kept.append(record);
    },
  };
  const app = useApp(databaseUrl, "call-unrecorded", () => ({ workflows: [post, repost], ledger: full }));
  const c = () => app.client;

  it("fails the run saying the call succeeded unrecorded, and makes no further call", async () => {
    const posted = await failure(c().result(await c().start(post, { text: "hi" }, { startedBy: alice })));
    expect((posted as Error).message).toMatch(
      /^bluesky\.post\.create succeeded, but the ledger could not record it: disk full/,
    );

    // A workflow that catches it and calls again is refused: the first call has no record.
    const reposted = await failure(c().result(await c().start(repost, {}, { startedBy: alice })));
    expect(errorCode(reposted)).toBe("run_ended");
    expect(app.ops()).toEqual(["bluesky.post.create", "bluesky.post.create"]);
    expect(app.vendors.bluesky.state.posts.map((p) => p.text)).toEqual(["hi", "once"]);
  });
});

describe("a worker stopping while a call fails for good", () => {
  // bluesky.post.create waits until released, then the vendor refuses it for good.
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const app = useApp(databaseUrl, "call-stopping", (vendors) => ({
    workflows: [post],
    drivers: [
      vendors.ghost.driver,
      vendors.resend.driver,
      {
        vendor: "bluesky",
        ops: {
          "post.create": async () => {
            entered.resolve();
            await released.promise;
            throw new DriverError("bluesky: the post is too long", { retryable: false, status: 400 });
          },
        },
      },
    ],
  }));
  const c = () => app.client;

  it("records the call's failure and the run's: they are its outcome, not the shutdown", async () => {
    const runId = await c().start(post, { text: "too long" }, { startedBy: alice });
    await entered.promise;
    // The worker is stopping (marked stopped) but DBOS has not shut down yet when the call fails.
    const shutdown = DBOS.shutdown.bind(DBOS);
    const shut = Promise.withResolvers<void>();
    vi.spyOn(DBOS, "shutdown").mockImplementationOnce(async (options) => {
      await shut.promise;
      return shutdown(options);
    });
    const stopping = app.stop();
    released.resolve();
    try {
      await waitFor(async () => (await c().ledger(runId)).some((r) => r.type === "run.failed"));
    } finally {
      shut.resolve();
      await stopping;
    }
    const records = await c().ledger(runId);
    const refused = { code: "driver_failed", message: "bluesky: the post is too long", status: 400 };
    expect(types(records)).toEqual(["run.started", "op.called bluesky.post.create", "run.failed"]);
    expect(records[1]).toMatchObject({ error: refused });
    expect(records[2]).toMatchObject({ error: refused });
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
      "sleep.started",
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
    for (const [runId, until] of [
      [isoPast!, Date.parse("2020-01-01T00:00:00Z")],
      [epochPast!, 0],
    ] as const) {
      expect(await c().result(runId)).toBe("rested");
      expect(await steps(runId)).not.toContain("DBOS.sleep");
      const records = await c().ledger(runId);
      expect(types(records)).toEqual(["run.started", "sleep.started", "run.finished"]);
      expect(records[1]).toMatchObject({ until, seq: 1, id: `${runId}:sleep.started:1` });
    }
    expect(await c().result(short!)).toBe("rested");
    expect(await steps(short!)).toEqual(["DBOS.sleep"]);
  });

  it("records when the sleep ends, before it waits: the time asked for, or the start plus the duration", async () => {
    const target = Date.now() + 400;
    const before = Date.now();
    const [timed, timer] = await Promise.all(
      [{ until: target }, { ms: 300 }].map((request) => c().start(nap, { request }, { startedBy: alice })),
    );
    await Promise.all([c().result(timed!), c().result(timer!)]);
    const [, slept] = await c().ledger(timed!);
    expect(slept).toMatchObject({ type: "sleep.started", until: target });
    const [, napped, finished] = await c().ledger(timer!);
    expect(napped).toMatchObject({ type: "sleep.started" });
    const until = (napped as { until: number }).until;
    expect(until - napped!.at).toBeGreaterThanOrEqual(300);
    expect(until).toBeGreaterThanOrEqual(before + 300);
    expect(finished!.at).toBeGreaterThanOrEqual(until);
  });

  it("records a sleep once when a restart interrupts it", async () => {
    const runId = await c().start(nap, { request: { seconds: 3 } }, { startedBy: alice });
    await waitFor(async () => (await c().ledger(runId)).some((r) => r.type === "sleep.started"));
    const [first] = (await c().ledger(runId)).filter((r) => r.type === "sleep.started");
    await app.restart();

    expect(await c().result(runId)).toBe("rested");
    const records = await c().ledger(runId);
    expect(types(records)).toEqual(["run.started", "sleep.started", "run.finished"]);
    expect(records[1]).toEqual(first);
    expect(await steps(runId)).toEqual(["DBOS.sleep"]);
  });
});

describe("the call a policy sees", () => {
  const seen: PolicyCall[] = [];
  const policy = definePolicy(
    // Async: a policy may return a promise of its decision.
    async (call) => {
      await Promise.resolve();
      // A copy proves the call is plain data: structuredClone refuses functions such as zod schemas.
      seen.push(structuredClone(call));
      if (call.target === "note/broken") throw new Error("no rule for broken notes");
      if (call.target === "note/odd") throw new SanomaError("invalid_input", "odd is no note id", { id: "odd" });
      return call.target === "note/locked"
        ? deny("the note is locked", ["note/locked is read-only"])
        : allow([`${call.op.id} may change ${call.target ?? "anything"}`]);
    },
    { version: "notes-1" },
  );
  const app = useApp(databaseUrl, "call-policy", (vendors) => ({
    workflows: [edit, post, tag],
    connectors: [ghost, resend, bluesky, notes, tags],
    drivers: [...vendors.drivers, notesDriver, tagsDriver],
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
    // What a policy test builds the op with.
    expect(seen[0]?.op).toEqual(policyOpOf(notes.note.update));
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

  it("fails the run naming the call when the policy throws", async () => {
    const runId = await c().start(edit, { id: "broken" }, { startedBy: alice });
    const err = await failure(c().result(runId));
    expect(err).toMatchObject({ message: "The policy failed deciding notes.note.update: no rule for broken notes" });
    expect(types(await c().ledger(runId))).toEqual(["run.started", "run.failed"]);
    expect((await c().ledger(runId)).at(-1)).toMatchObject({
      error: { message: "The policy failed deciding notes.note.update: no rule for broken notes" },
    });

    // A coded error keeps its code and data through the naming.
    const odd = await failure(c().result(await c().start(edit, { id: "odd" }, { startedBy: alice })));
    expect(errorCode(odd)).toBe("invalid_input");
    expect(odd).toMatchObject({
      message: "The policy failed deciding notes.note.update: odd is no note id",
      data: { id: "odd" },
    });
  });

  it("fails the run, before the policy decides, when the operation's target is not a string", async () => {
    seen.length = 0;
    const runId = await c().start(tag, { id: "t1" }, { startedBy: alice });
    const err = await failure(c().result(runId));
    expect(err).toMatchObject({ message: "tags.tag.add: `target` returned number, not a string" });
    expect(seen).toEqual([]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "run.failed"]);
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

describe("ctx.all", () => {
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

  /** Leaves a ctx.all un-awaited while it calls on, as the lint would refuse, to show what is recorded. */
  const loose = defineWorkflow({
    name: "loose",
    trigger: "manual",
    input: z.object({ shape: z.enum(["outside", "twice"]) }),
    uses: [bluesky.post.create, "all"],
    run: async (ctx, { shape }) => {
      const group = ctx.all([
        () => ctx.bluesky.post.create({ text: "one" }),
        () => ctx.bluesky.post.create({ text: "two" }),
      ]);
      if (shape === "outside") {
        // Made while the first member runs, but not in it.
        await ctx.bluesky.post.create({ text: "outside" });
        return (await group).length;
      }
      const refused = await ctx
        .all([() => ctx.bluesky.post.create({ text: "three" })])
        .catch((err: Error) => `${errorCode(err)}: ${err.message}`);
      await group;
      return refused;
    },
  });

  const app = useApp(
    databaseUrl,
    "call-all",
    (vendors) => ({
      workflows: [fanout, signed, broken, odd, loose],
      connectors: [ghost, resend, bluesky, stats],
      drivers: vendors.drivers,
    }),
    { extra: [fakeStats] },
  );
  const c = () => app.client;
  const posted = () => app.vendors.bluesky.state.posts.map((p) => p.text);

  it("runs the members in order, returns their outputs in order, and tags their records with the group", async () => {
    const runId = await c().start(fanout, { title: "Launch" }, { startedBy: alice });
    expect(await c().result(runId)).toEqual({ post: expect.any(String), views: 42, opens: 7 });
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "bluesky.post.create",
      "stats.post.views",
      "stats.email.opens",
    ]);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "op.called bluesky.post.create",
      "sleep.started",
      "op.called stats.post.views",
      "op.called stats.email.opens",
      "run.finished",
    ]);
    // Each group is named for the seq the run was at when it began, which its first call took.
    expect(groups(records)).toEqual([
      undefined,
      { id: "all:1", index: 0, size: 3 },
      { id: "all:1", index: 1, size: 3 },
      { id: "all:1", index: 2, size: 3 },
      undefined,
      { id: "all:5", index: 0, size: 2 },
      { id: "all:5", index: 1, size: 2 },
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
    const group = { id: "all:1", size: 2 };
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
    expect(posted()).toEqual(["first"]);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called bluesky.post.create",
      "op.called ghost.post.publish",
      "run.failed",
    ]);
    expect(records[2]).toMatchObject({ group: { id: "all:1", index: 1, size: 3 }, error: { code: "driver_failed" } });
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

  it("does not tag a call made outside the group while a member runs", async () => {
    const runId = await c().start(loose, { shape: "outside" }, { startedBy: alice });
    expect(await c().result(runId)).toBe(2);
    expect(posted()).toEqual(["one", "outside", "two"]);
    const group = { id: "all:1", size: 2 };
    expect(groups(await c().ledger(runId))).toEqual([
      undefined,
      { ...group, index: 0 },
      undefined,
      { ...group, index: 1 },
      undefined,
    ]);
  });

  it("refuses a second ctx.all while one runs, and keeps the first one's tags", async () => {
    const runId = await c().start(loose, { shape: "twice" }, { startedBy: alice });
    expect(await c().result(runId)).toBe("invalid_input: a ctx.all is already running: await it before the next");
    expect(posted()).toEqual(["one", "two"]);
    const group = { id: "all:1", size: 2 };
    expect(groups(await c().ledger(runId))).toEqual([
      undefined,
      { ...group, index: 0 },
      { ...group, index: 1 },
      undefined,
    ]);
  });

  it("returns [] for no members, and writes nothing for them", async () => {
    const runId = await c().start(odd, { shape: "empty" }, { startedBy: alice });
    expect(await c().result(runId)).toEqual([]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "run.finished"]);
  });

  it("replays the members a stopped worker finished, and runs the one it was in once", async () => {
    const release = app.vendors.bluesky.hold("bluesky.post.create");
    const runId = await c().start(fanout, { title: "Restarted" }, { startedBy: alice });
    await waitFor(() => app.ops().includes("bluesky.post.create"));

    await app.restart();
    await waitFor(() => app.ops().filter((op) => op === "bluesky.post.create").length === 2);
    release();

    expect(await c().result(runId)).toMatchObject({ views: 42, opens: 7 });
    // Members 1 and 2 came back from their recorded steps; member 3 was called again with its key.
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "bluesky.post.create",
      "bluesky.post.create",
      "stats.post.views",
      "stats.email.opens",
    ]);
    const posts = app.vendors.calls.filter((call) => call.op === "bluesky.post.create");
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
    expect(posted()).toEqual(["Restarted"]);

    const records = await c().ledger(runId);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "op.called bluesky.post.create",
      "sleep.started",
      "op.called stats.post.views",
      "op.called stats.email.opens",
      "run.finished",
    ]);
    expect(records[3]).toMatchObject({ group: { id: "all:1", index: 2, size: 3 } });
  });
});

describe("a call queued behind a refused one", () => {
  // Both calls are made at once; the publish is refused, which ends the run.
  // How the queued call fails is kept: refused by the runtime, not by DBOS finding the run
  // already over.
  const queuedFailed: unknown[] = [];
  const kept = (p: Promise<unknown>) =>
    p.catch((e: unknown) => {
      queuedFailed.push(e);
      throw e;
    });
  const both = defineWorkflow({
    name: "both",
    trigger: "manual",
    input: z.object({ id: z.string() }),
    uses: [ghost.post.publish, bluesky.post.create],
    run: async (ctx, { id }) =>
      Promise.all([ctx.ghost.post.publish({ id }), kept(ctx.bluesky.post.create({ text: "too" }))]),
  });
  // The same, with an approval or a sleep queued behind the refused publish.
  const asking = defineWorkflow({
    name: "asking",
    trigger: "manual",
    input: z.object({ id: z.string() }),
    uses: [ghost.post.publish, "approval"],
    run: async (ctx, { id }) =>
      Promise.all([ctx.ghost.post.publish({ id }), kept(ctx.approval("Then this", { approver: "marketing-lead" }))]),
  });
  const napping = defineWorkflow({
    name: "napping",
    trigger: "manual",
    input: z.object({ id: z.string() }),
    uses: [ghost.post.publish, "sleep"],
    run: async (ctx, { id }) => Promise.all([ctx.ghost.post.publish({ id }), kept(ctx.sleep({ ms: 50 }))]),
  });
  const policy = definePolicy(({ op }) => (op.id === "ghost.post.publish" ? deny("not today") : allow()));
  const app = useApp(databaseUrl, "call-ended", () => ({ workflows: [both, asking, napping], policy }));
  const c = () => app.client;
  const steps = async (runId: string) => ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);

  it("never reaches its vendor once the run has failed", async () => {
    queuedFailed.length = 0;
    const runId = await c().start(both, { id: "p1" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    // Time for the queued call to run, had it been going to.
    await new Promise((r) => setTimeout(r, 300));

    expect(queuedFailed.map(errorCode)).toEqual(["run_ended"]);
    // Its policy step may have run (a decision, no side effect), but never the vendor's step.
    expect(await steps(runId)).not.toContain("bluesky.post.create");
    expect(app.ops()).toEqual([]);
    expect(app.vendors.bluesky.state.posts).toEqual([]);
    const records = await c().ledger(runId);
    expect(records.some((r) => r.type === "op.called" && r.op === "bluesky.post.create" && "output" in r)).toBe(false);
    expect(types(records)).toEqual(["run.started", "op.called ghost.post.publish", "run.failed"]);
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: { code: "policy_denied" } });
  });

  it("never publishes an approval queued behind it", async () => {
    queuedFailed.length = 0;
    const runId = await c().start(asking, { id: "p2" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    await new Promise((r) => setTimeout(r, 300));

    expect(queuedFailed.map(errorCode)).toEqual(["run_ended"]);
    expect(await c().approvals(runId)).toEqual([]);
    expect(await steps(runId)).toEqual(["policy:ghost.post.publish"]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "op.called ghost.post.publish", "run.failed"]);
  });

  it("never sleeps for a sleep queued behind it", async () => {
    queuedFailed.length = 0;
    const runId = await c().start(napping, { id: "p3" }, { startedBy: alice });
    expect(errorCode(await failure(c().result(runId)))).toBe("policy_denied");
    await new Promise((r) => setTimeout(r, 300));

    expect(queuedFailed.map(errorCode)).toEqual(["run_ended"]);
    expect(await steps(runId)).toEqual(["policy:ghost.post.publish"]);
    expect(types(await c().ledger(runId))).toEqual(["run.started", "op.called ghost.post.publish", "run.failed"]);
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
