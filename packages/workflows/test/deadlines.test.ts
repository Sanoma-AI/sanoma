import { randomUUID } from "node:crypto";
import { DBOS, type DBOSClient, type WorkflowStatus } from "@dbos-inc/dbos-sdk";
import { startTestWorker, testDatabaseUrl } from "@sanoma-ai/testing";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dbosClient, prepareDatabase, WAKEUP_TABLE } from "../src/db.ts";
import { deadlineRegistry, idle } from "../src/deadlines.ts";
import {
  type CallContext,
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type SelfStop,
  shouldWake,
  type WakeupSpec,
  withSetup,
  type Worker,
  type WorkerOptions,
} from "../src/index.ts";
import { rootWith, waitFor } from "./harness.ts";

// A wakeup type whose register records each call, and a gate operation that holds a run inside
// a step until the test lets it go.
const wakeupType = defineResource({
  vendor: "acme",
  type: "wakeup",
  title: "Wakeup",
  identity: "name",
  schema: z.object({ name: z.string(), host: z.string() }),
  fields: {
    immutable: [],
    vendorOwned: [],
    writeOnly: [],
    references: { host: { type: "acme.service", by: ["url"] } },
  },
  find: ({ name }) => name,
  writable: true,
  wakeup: {
    inputs: { host: "host" },
    register: "acme.wakeup.register",
    outputs: () => ({ healthy: true }),
  } satisfies WakeupSpec,
});
const types = defineConnector("acme", { wakeup: wakeupType }, { package: "@acme/connector" });
const ops = defineConnector("acme", {
  wakeup: {
    register: {
      effect: "write",
      idempotent: true,
      input: z.object({ at: z.iso.datetime(), generation: z.number().int() }),
      output: z.object({}),
      target: () => "w",
    },
  },
  gate: { hold: { effect: "read", idempotent: true, input: z.object({}), output: z.object({}) } },
});
const acmeOps = { ...types, wakeup: { ...types.wakeup, ...ops.wakeup }, gate: ops.gate } as typeof types & typeof ops;

const registered: { input: unknown; context: CallContext }[] = [];
let registerFails: Error | undefined;
let gate = Promise.withResolvers<void>();
let held = false;
const notHere = async (): Promise<never> => {
  throw new Error("not in this test");
};
const acme = withSetup(acmeOps, {
  driver: () =>
    defineDriver(acmeOps, {
      wakeup: {
        read: notHere,
        import: notHere,
        plan: notHere,
        create: notHere,
        update: notHere,
        delete: notHere,
        register: async (input, context) => {
          if (registerFails) throw registerFails;
          registered.push({ input, context });
          return {};
        },
      },
      gate: {
        hold: async () => {
          held = true;
          await gate.promise;
          return {};
        },
      },
    }),
});

const nap = defineWorkflow({
  name: "nap",
  trigger: "manual",
  input: z.object({ seconds: z.number() }),
  uses: ["sleep"],
  run: async (ctx, { seconds }) => {
    await ctx.sleep({ seconds });
    return "rested";
  },
});
const ask = defineWorkflow({
  name: "ask",
  trigger: "manual",
  input: z.object({}),
  uses: ["approval"],
  run: async (ctx) => {
    await ctx.approval("Go?", { approver: "lead" });
    return "asked";
  },
});
const hold = defineWorkflow({
  name: "hold",
  trigger: "manual",
  input: z.object({}),
  uses: [acmeOps.gate.hold],
  run: async (ctx) => ctx.acme.gate.hold({}),
});

const alice = { id: "alice" };
const WAKEUP_FILE =
  'import { acme } from "@acme/connector/resources";\n' +
  'export const wake = acme.wakeup({ name: "wake", host: "https://app.example.test" });\n';

/** A worker on its own database, a client and a raw DBOS client of it, and the worker started again on demand. */
function useWorker(name: string, files: Record<string, string>) {
  const databaseUrl = testDatabaseUrl(name);
  const config: SanomaConfig = {
    workflows: [nap, ask, hold],
    connectors: [acme],
    root: rootWith(files),
    ledger: memoryLedger(),
    databaseUrl,
  };
  const ctx = {
    config,
    databaseUrl,
    worker: undefined as Worker | undefined,
    client: undefined as unknown as SanomaClient,
    raw: undefined as unknown as DBOSClient,
    pool: undefined as unknown as Pool,
    async start(options: WorkerOptions = {}) {
      await ctx.worker?.stop();
      ctx.worker = await startTestWorker(config, { databaseUrl, quiet: true, ...options });
      return ctx.worker;
    },
    async row() {
      const { rows } = await ctx.pool.query(`SELECT * FROM ${WAKEUP_TABLE}`);
      return rows[0] as {
        owner: string | null;
        generation: string;
        at: Date | null;
        stopped_at: Date | null;
        registered_at: Date | null;
        last_error: string | null;
      };
    },
    /** Cancels every run left unfinished, so the next test's worker recovers none. */
    async cancelAll() {
      const runs = await ctx.raw.listWorkflows({ status: ["PENDING", "ENQUEUED", "DELAYED"], loadInput: false });
      if (runs.length) await ctx.raw.cancelWorkflows(runs.map((r) => r.workflowID));
    },
  };
  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    ctx.client = await SanomaClient.connect(config);
    ctx.raw = await dbosClient(databaseUrl, resolveConfig(config).appName);
    ctx.pool = new Pool({ connectionString: databaseUrl });
    await ctx.cancelAll();
  }, 60_000);
  afterEach(async () => {
    await ctx.worker?.stop();
    ctx.worker = undefined;
    await ctx.cancelAll();
    registered.length = 0;
    registerFails = undefined;
    gate.resolve();
    gate = Promise.withResolvers<void>();
    held = false;
  });
  afterAll(async () => {
    await ctx.client?.close();
    await ctx.raw?.destroy();
    await ctx.pool?.end();
  });
  return ctx;
}

const untilOf = async (client: SanomaClient, runId: string) => {
  const record = (await client.ledger(runId)).find((r) => r.type === "sleep.started") as { until: number } | undefined;
  return record?.until;
};

describe("the deadline registry", () => {
  it("counts a run busy inside its body and waiting inside a wrapped wait, with a sleep's deadline", async () => {
    const deadlines = deadlineRegistry();
    const { promise: slept, resolve: release } = Promise.withResolvers<void>();
    const run = deadlines.running("r1", async () => {
      expect(deadlines.busy).toBe(1);
      await deadlines.waiting("r1", { kind: "sleep", until: 5_000 }, () => slept);
      expect(deadlines.busy).toBe(1);
      return "done";
    });
    expect(deadlines.busy).toBe(0);
    expect(deadlines.waitOf("r1")).toEqual({ kind: "sleep", until: 5_000 });
    expect(deadlines.nextDeadline()).toEqual(new Date(5_000));
    release();
    expect(await run).toBe("done");
    expect(deadlines.busy).toBe(0);
    expect(deadlines.waitOf("r1")).toBeUndefined();
    expect(deadlines.nextDeadline()).toBeUndefined();
  });

  it("takes the earliest of the sleeps and the sources; an approval has no deadline", async () => {
    const deadlines = deadlineRegistry();
    const forever = new Promise<void>(() => {});
    void deadlines.running("a", () => deadlines.waiting("a", { kind: "approval" }, () => forever));
    void deadlines.running("s", () => deadlines.waiting("s", { kind: "sleep", until: 9_000 }, () => forever));
    expect(deadlines.nextDeadline()).toEqual(new Date(9_000));
    let source: Date | undefined = new Date(7_000);
    deadlines.addSource(() => source);
    expect(deadlines.nextDeadline()).toEqual(new Date(7_000));
    source = undefined;
    expect(deadlines.nextDeadline()).toEqual(new Date(9_000));
    expect(deadlines.busy).toBe(0);
  });
});

const scope = { appName: "app", version: "app@v2", queueName: "sanoma:app" };
/** A run of `scope`'s, PENDING on its version and queue, but for what `s` says. */
const status = (s: Partial<WorkflowStatus>): WorkflowStatus =>
  ({
    workflowID: randomUUID(),
    status: "PENDING",
    applicationVersion: "app@v2",
    queueName: "sanoma:app",
    ...s,
  }) as WorkflowStatus;
/** DBOS answering with `runs` unfinished, and `latest` as the app's latest version. */
const listing = (runs: WorkflowStatus[], latest = "app@v2") => {
  vi.spyOn(DBOS, "listWorkflows").mockResolvedValue(runs);
  vi.spyOn(DBOS, "getLatestApplicationVersion").mockResolvedValue({ versionName: latest } as never);
};

describe("idle", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["nothing unfinished", [], true],
    ["a run of this version queued", [status({ status: "ENQUEUED" })], false],
    ["a run of this version delayed", [status({ status: "DELAYED" })], false],
    ["a run recovered onto DBOS's queue", [status({ status: "ENQUEUED", queueName: "_dbos_internal_queue" })], false],
    ["a run of this version started outside a queue", [status({ queueName: undefined })], false],
    ["a run of this version running and in no wait", [status({})], false],
    ["a run of another version running", [status({ applicationVersion: "app@v1" })], true],
    ["a run of another version queued", [status({ status: "ENQUEUED", applicationVersion: "app@v1" })], true],
    ["a run on another queue", [status({ status: "ENQUEUED", queueName: "sanoma" })], true],
    [
      "a run queued without a version, this version the latest",
      [status({ status: "ENQUEUED", applicationVersion: undefined })],
      false,
    ],
  ])("with %s is %s", async (_, runs, expected) => {
    listing(runs as WorkflowStatus[]);
    expect(await idle(deadlineRegistry(), scope, 60_000)).toBe(expected);
  });

  it("leaves a run queued without a version to the latest version, when that is another", async () => {
    listing([status({ status: "ENQUEUED", applicationVersion: undefined })], "app@v3");
    expect(await idle(deadlineRegistry(), scope, 60_000)).toBe(true);
  });

  it("counts a PENDING run as waiting only while it is in a wrapped wait, and keeps the worker up for a deadline within the horizon", async () => {
    const deadlines = deadlineRegistry();
    const run = status({});
    listing([run]);
    const forever = new Promise<void>(() => {});
    void deadlines.running(run.workflowID, () =>
      deadlines.waiting(run.workflowID, { kind: "approval" }, () => forever),
    );
    expect(await idle(deadlines, scope, 60_000)).toBe(true);
    deadlines.addSource(() => new Date(Date.now() + 30_000));
    expect(await idle(deadlines, scope, 60_000)).toBe(false);
    expect(await idle(deadlines, scope, 10_000)).toBe(true);
  });

  it("is false while a run is busy, before DBOS is asked", async () => {
    const deadlines = deadlineRegistry();
    const list = vi.spyOn(DBOS, "listWorkflows");
    void deadlines.running("busy", () => new Promise(() => {}));
    expect(await idle(deadlines, scope, 60_000)).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("a worker's deadlines", () => {
  const app = useWorker("deadlines", {});

  it("counts a run waiting for an approval as waiting, with no deadline, and the worker idle", async () => {
    const worker = await app.start();
    const runId = await app.client.start(ask, {}, { startedBy: alice });
    await waitFor(() => worker.deadlines.waitOf(runId)?.kind === "approval");
    expect(worker.deadlines.busy).toBe(0);
    expect(worker.deadlines.nextDeadline()).toBeUndefined();
    expect(await worker.idle()).toBe(true);
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    expect(await app.client.result(runId)).toBe("asked");
  });

  it("counts a run inside a step as busy, and the worker not idle", async () => {
    const worker = await app.start();
    const runId = await app.client.start(hold, {}, { startedBy: alice });
    await waitFor(() => held);
    expect(worker.deadlines.busy).toBe(1);
    expect(worker.deadlines.waitOf(runId)).toBeUndefined();
    expect(await worker.idle()).toBe(false);
    gate.resolve();
    await app.client.result(runId);
    await waitFor(() => worker.deadlines.busy === 0);
  });

  it("keeps a sleep's deadline across a restart, from DBOS's clock: the ledger's and the registry's agree", async () => {
    const worker = await app.start({ idleHorizonMs: 10_000 });
    const runId = await app.client.start(nap, { seconds: 120 }, { startedBy: alice });
    await waitFor(() => worker.deadlines.waitOf(runId) !== undefined);
    const until = await untilOf(app.client, runId);
    expect(worker.deadlines.waitOf(runId)).toEqual({ kind: "sleep", until });
    expect(worker.deadlines.nextDeadline()).toEqual(new Date(until!));
    // Past the horizon: nothing can run before it.
    expect(await worker.idle()).toBe(true);
    worker.deadlines.addSource(() => new Date(Date.now() + 5_000));
    expect(await worker.idle()).toBe(false);

    // Later than the first start, so a deadline computed again from the clock would differ.
    await new Promise((r) => setTimeout(r, 50));
    const again = await app.start();
    await waitFor(() => again.deadlines.waitOf(runId) !== undefined);
    expect(again.deadlines.waitOf(runId)).toEqual({ kind: "sleep", until });
    expect(await untilOf(app.client, runId)).toBe(until);
    // The default horizon, a minute, is shorter than the sleep.
    expect(await again.idle()).toBe(true);
  });

  it("is false once stopped, and stops once for two calls", async () => {
    const worker = await app.start();
    await Promise.all([worker.stop(), worker.stop()]);
    expect(await worker.idle()).toBe(false);
  });
});

describe("the stop rule", () => {
  const app = useWorker("deadlines_stop", { "resources/infra.ts": WAKEUP_FILE });
  const fast = { stopCheckMs: 100, idleHorizonMs: 1_000 };

  it("registers the next deadline with a new generation and stops; a second start recovers the sleeping run", async () => {
    const before = Number((await app.row()).generation);
    // Queued before the worker starts, so its first check finds the run.
    const runId = await app.client.start(nap, { seconds: 3 }, { startedBy: alice });
    const stops: SelfStop[] = [];
    const worker = await app.start({ ...fast, onStopped: (s) => stops.push(s) });
    await waitFor(() => stops.length === 1);
    const until = await untilOf(app.client, runId);
    const at = new Date(until!).toISOString();
    expect(stops).toEqual([{ at, generation: before + 1 }]);
    expect(registered).toEqual([
      {
        input: { at, generation: before + 1 },
        context: expect.objectContaining({
          idempotencyKey: `wakeup:resources/infra.ts#wake:${before + 1}`,
          opId: "acme.wakeup.register",
          attempt: 1,
          by: "wakeup",
        }),
      },
    ]);
    const row = await app.row();
    expect(row).toMatchObject({ generation: String(before + 1), at: new Date(until!), last_error: null });
    expect(row.owner).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.registered_at).toBeInstanceOf(Date);
    expect(row.stopped_at).toBeInstanceOf(Date);
    expect(await worker.idle()).toBe(false);
    // Nothing recorded the stop as the run's end.
    expect((await app.client.ledger(runId)).map((r) => r.type)).toEqual(["run.started", "sleep.started"]);

    expect(await shouldWake(app.databaseUrl, before + 1)).toBe(true);
    expect(await shouldWake(app.databaseUrl, before)).toBe(false);
    // Registered by a worker that then kept running: no stop is behind that wake.
    await app.pool.query(`UPDATE ${WAKEUP_TABLE} SET registered_at = stopped_at + interval '1 second' WHERE id = 1`);
    expect(await shouldWake(app.databaseUrl, before + 1)).toBe(false);

    const again = await app.start({ idleHorizonMs: 60_000, onStopped: () => {} });
    expect((await app.row()).owner).not.toBe(row.owner);
    expect(await app.client.result(runId)).toBe("rested");
    expect(again.deadlines.waitOf(runId)).toBeUndefined();
    expect(await untilOf(app.client, runId)).toBe(until);
  });

  it("keeps running when the register fails, recording why, and stops once it succeeds", async () => {
    registerFails = new Error("the wakeup service is down");
    const { stopped_at } = await app.row();
    await app.client.start(nap, { seconds: 30 }, { startedBy: alice });
    const stops: SelfStop[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const worker = await app.start({ ...fast, onStopped: (s) => stops.push(s) });
    await waitFor(async () => (await app.row()).last_error !== null);
    const failed = await app.row();
    expect(failed.last_error).toBe("the wakeup service is down");
    expect(failed.stopped_at).toEqual(stopped_at);
    expect(stops).toEqual([]);
    expect(await worker.idle()).toBe(true);
    // Tried again at each check, logged once.
    await waitFor(async () => Number((await app.row()).generation) > Number(failed.generation));
    expect(warn.mock.calls.filter(([line]) => String(line).includes("could not register the wakeup"))).toHaveLength(1);
    warn.mockRestore();

    registerFails = undefined;
    await waitFor(() => stops.length === 1);
    expect(stops[0]!.generation).toBeGreaterThan(Number(failed.generation));
    expect(await app.row()).toMatchObject({ last_error: null, generation: String(stops[0]!.generation) });
  });

  it("never stops a worker whose caller would not hear it stop", async () => {
    await app.client.start(nap, { seconds: 30 }, { startedBy: alice });
    const { generation } = await app.row();
    const worker = await app.start(fast);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await worker.idle()).toBe(true);
    expect(registered).toEqual([]);
    expect((await app.row()).generation).toBe(generation);
  });

  it("does nothing while another worker owns the row", async () => {
    await app.client.start(nap, { seconds: 30 }, { startedBy: alice });
    const stops: SelfStop[] = [];
    const worker = await app.start({ ...fast, stopCheckMs: 300, onStopped: (s) => stops.push(s) });
    const other = randomUUID();
    await app.pool.query(`UPDATE ${WAKEUP_TABLE} SET owner = $1 WHERE id = 1`, [other]);
    const { generation } = await app.row();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await app.row()).toMatchObject({ owner: other, generation });
    expect(registered).toEqual([]);
    expect(stops).toEqual([]);
    expect(await worker.idle()).toBe(true);
  });

  it("stops with no deadline, registering nothing, while a run waits for an approval", async () => {
    const runId = await app.client.start(ask, {}, { startedBy: alice });
    const stops: SelfStop[] = [];
    await app.start({ ...fast, onStopped: (s) => stops.push(s) });
    await waitFor(() => stops.length === 1);
    expect(stops[0]!.at).toBeNull();
    expect(registered).toEqual([]);
    expect(await app.row()).toMatchObject({ at: null, generation: String(stops[0]!.generation) });
    expect(await app.client.approvals(runId)).toMatchObject([{ status: "pending" }]);

    // The decision's request starts a worker again, which reads it.
    await app.start({ stopCheckMs: 60_000 });
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    expect(await app.client.result(runId)).toBe("asked");
  });
});
