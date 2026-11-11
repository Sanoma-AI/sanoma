import { dequal } from "dequal";
import { z } from "zod";
import type { RunSummary } from "./client.ts";
import { type Collection, collectionsConnector, collectionsFake } from "./collection.ts";
import {
  callsOf,
  checkApproval,
  checkSleep,
  ctxOf,
  type CtxRunner,
  inputOf,
  opCalled,
  outputsOf,
  recordOf,
  recorded,
  untilOf,
} from "./ctx.ts";
import { AllMembers, type ApprovalState, opIdsOf, type Principal, type WorkflowDefinition } from "./define.ts";
import { isDirect } from "./direct.ts";
import { errorInfo, parseOrThrow, RejectedError, SanomaError } from "./errors.ts";
import type { Fake } from "./fake.ts";
import { applyGivens, refuseUnfaked } from "./givens.ts";
import type { LedgerBody, LedgerGroup, LedgerRecord } from "./ledger.ts";
import { type CallContext, type Connector, type DriverFn, indexConnectors, makersOf, type Op } from "./op.ts";
import { resourceTypesOf } from "./resource.ts";
import type { World } from "./scenario.ts";
import { memorySecrets, type Secrets } from "./secret.ts";
import { ANONYMOUS_PRINCIPAL, apiNameOf, DATA_VENDOR, errorMessage, isEnded, type RunStatus } from "./shared.ts";

// A company's workflows run inside a browser page (`sanoma/workflows/page`): the base of a
// static demo. Every vendor is its connector's fake and every collection is in memory, so
// nothing leaves the page. A run's `ctx` is built as a worker's is (`ctxOf`), but there is no
// DBOS, no policy and no store: a run is a promise, its records a list, and a sleep a timer of
// the page's, which `reset` and `stop` clear.

/** What a page's `api` sends (`createApi`'s `Transport`): an operation's id or a workflow's api name, its input, and a start's id. */
export interface PageRequest {
  name: string;
  input?: unknown;
  id?: string;
}

export interface PageRuntimeOptions {
  workflows: readonly WorkflowDefinition<any, any>[];
  collections?: readonly Collection[];
  /** The connectors the workflows call, as their packages export them: each one's fake (`withSetup`'s `fake`) stands in for its vendor. */
  connectors?: readonly Connector<any, any>[];
  /** The world every run starts from (`loadWorld`): its `Given` steps applied to the fakes at the start and on `reset`. */
  world?: World;
  /** Who starts every run and makes every call: `anonymous` unless given. */
  actor?: Principal;
  /** How an approval a run asks for is decided, at once: approved unless this says otherwise. */
  decide?: (approval: ApprovalState) => "approve" | "reject" | Promise<"approve" | "reject">;
}

export interface PageRuntime {
  /** Answers what `callApi` answers for a site's `api`, in the page: hand it to `createApi`. */
  transport(request: PageRequest): Promise<unknown>;
  /** Back to the world as it began: fresh fakes, seeded again, and no runs, each dropped as `stop` drops it. */
  reset(): Promise<void>;
  /**
   * Drops every run: a sleeping one's sleep fails with `run_ended`, its timer cleared, and any
   * call a run makes after it never settles, so the run goes no further: a demo's unmount. A run
   * awaiting an operation or `decide` stops at its next call. Until a `reset` seeds again, a run
   * started after it stops at its first call.
   */
  stop(): void;
}

/** The app name a page's records carry, as a worker's carry its config's. */
const PAGE_APP = "page";

/** One run in the page: its records and its approvals. */
interface PageRun {
  id: string;
  workflow: string;
  /** What it was started with, as given. */
  input: unknown;
  actor: Principal;
  status: RunStatus;
  createdAt: number;
  updatedAt?: number;
  seq: number;
  records: LedgerRecord[];
  approvals: ApprovalState[];
  /** The `ctx.all` member the run is in, which its records carry. */
  group?: LedgerGroup;
  error?: string;
  /** Settles as the run ends: its output, or its failure. */
  done: Promise<unknown>;
}

/** The fakes' operations by id, seeded, and the secrets they read: made again on `reset`. */
interface Seeded {
  drivers: Map<string, DriverFn>;
  secrets: Secrets;
}

/** The operation called on its fake in `seeded`, its output checked against its schema. */
const callFake = async (
  { drivers, secrets }: Seeded,
  op: Op,
  parsed: unknown,
  context: Omit<CallContext, "secrets">,
) => {
  const fn = drivers.get(op.id);
  if (!fn) {
    throw new SanomaError("invalid_input", `${op.id} has no fake in this page: no connector given attaches one`, {
      op: op.id,
    });
  }
  return op.output.parse(await fn(parsed, { ...context, secrets }));
};

const RunRef = z.object({ runId: z.string().min(1) });
const ResultRef = RunRef.extend({ waitMs: z.number().int().min(0).optional() });
const RunsLimit = z.object({ limit: z.number().int().positive().optional() });

/**
 * A call of a dropped run: it never settles, so the run stops there, one that caught the drop's
 * error too, rather than spinning on calls that fail at once. A new promise each time, so nothing
 * holds the run once the page lets it go.
 */
const halted = () => new Promise<never>(() => {});

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days): a longer one would fire at once. */
const MAX_DELAY = 2 ** 31 - 1;

/** Resolves at `until` (ms since the epoch) on the page's timers, or at once for a time past; rejects with `signal`'s reason, its timer cleared, once it aborts. */
const waitUntil = (until: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const next = () => {
      const left = until - Date.now();
      if (left > 0) return void (timer = setTimeout(next, Math.min(left, MAX_DELAY)));
      signal.removeEventListener("abort", drop);
      resolve();
    };
    signal.addEventListener("abort", drop, { once: true });
    next();
  });

/**
 * The page's runtime: `transport` takes what a site's `api` sends (`createApi`), as the app's
 * `callApi` does. An operation `isDirect` allows is called on its fake, as the actor; a
 * workflow's api name (`apiNameOf`) or `<name>.start` starts a run, `{ runId }` (a start's `id`
 * is its run's id, and the same id again is the same run); `.result` (`{ runId, waitMs? }`) waits for the
 * run's end, its output or its failure, or `run_running` once `waitMs` has passed; `.latest`, `.runs` (`{ limit? }`, 20 unless given), `.approvals` and
 * `.ledger` (`{ runId }`, the run's records in order: its run card) read the runs. Each
 * approval is decided at once (`decide`), and `ctx.sleep` waits its time, as a worker's does: the
 * run rests at its `sleep.started`, `running`, until a timer of the page's wakes it. Refuses a
 * workflow that uses an operation no fake implements, and a world its fakes cannot take.
 */
export async function pageRuntime(options: PageRuntimeOptions): Promise<PageRuntime> {
  const {
    workflows,
    collections = [],
    connectors = [],
    world = { name: "world", given: [] },
    actor = ANONYMOUS_PRINCIPAL,
  } = options;
  const decide = options.decide ?? (() => "approve");
  const ops = indexConnectors([...connectors, ...(collections.length ? [collectionsConnector(collections)] : [])]);
  const types = resourceTypesOf(connectors);
  const makers = makersOf(connectors, "fake") as Map<string, () => Fake<unknown>>;
  if (collections.length) makers.set(DATA_VENDOR, () => collectionsFake(collections));
  const byApi = new Map(workflows.map((wf) => [apiNameOf(wf.name), wf]));

  /** Fresh fakes, seeded from the world. */
  const make = async (): Promise<Seeded> => {
    const fakes = new Map([...makers].map(([vendor, maker]) => [vendor, maker()]));
    const drivers = new Map(
      [...fakes.values()].flatMap((f) =>
        Object.entries(f.driver.ops).map(([key, fn]) => [`${f.driver.vendor}.${key}`, fn] as const),
      ),
    );
    const secrets = memorySecrets();
    await applyGivens(world, {
      drivers,
      fakes,
      fakeOf: (vendor) => fakes.get(vendor)!,
      ops,
      call: (i, opId) => ({ idempotencyKey: `world:${i}`, runId: "world", opId, attempt: 1, secrets }),
    });
    return { drivers, secrets };
  };

  let current = await make();
  for (const wf of workflows) {
    refuseUnfaked(opIdsOf(wf), current.drivers, (missing, why) => `Workflow "${wf.name}" uses ${missing}, but ${why}`, {
      workflow: wf.name,
    });
  }
  let runs = new Map<string, PageRun>();
  let started = 0;
  /** Aborted to drop the runs started under it (`stop`, `reset`): each sleep's timer cleared, each call after halted. */
  let dropping = new AbortController();

  /** Appends a record to the run, now, with the next `seq` unless one is given, keyed as a worker keys it. */
  const write = (run: PageRun, body: LedgerBody, { seq = run.seq++, key }: { seq?: number; key?: string } = {}) =>
    run.records.push(recordOf(run, PAGE_APP, body, { seq, at: Date.now(), key, group: run.group }));

  /**
   * How the run's `ctx` members are made in the page: on the world's fakes, at once, but a sleep,
   * which waits; none once the run has ended, and none settling once `dropped` has aborted.
   */
  const runnerOf = (run: PageRun, seeded: Seeded, dropped: AbortSignal): CtxRunner => ({
    place: () => {
      if (isEnded(run.status)) {
        throw new SanomaError("run_ended", `run ${run.id} has ended; a call made after it was not`, { runId: run.id });
      }
      return undefined;
    },
    async op(op, input, at) {
      if (dropped.aborted) return halted();
      const parsed = inputOf(op, input);
      // Recorded as a worker records it: one `op.called` per call it makes (a batch's entries).
      const calls = callsOf(op, parsed, ops);
      const seq = run.seq;
      run.seq += calls.length;
      const begun = Date.now();
      const records = (outcome: (i: number) => Partial<LedgerBody>) =>
        calls.forEach((c, i) =>
          write(
            run,
            {
              ...opCalled(c, run.workflow),
              ...at,
              decision: { kind: "allow" },
              attempt: 1,
              durationMs: Date.now() - begun,
              ...outcome(i),
            } as LedgerBody,
            { seq: seq + i },
          ),
        );
      let output: unknown;
      try {
        output = await callFake(seeded, op, parsed, {
          idempotencyKey: `${run.id}:${seq}`,
          runId: run.id,
          opId: op.id,
          attempt: 1,
          principal: run.actor,
          by: `run:${run.id}`,
        });
      } catch (err) {
        records(() => ({ error: errorInfo(err) }));
        throw err;
      }
      const outputs = outputsOf(op, output);
      records((i) => ({ output: recorded(calls[i]!.op, outputs[i], run.workflow) }));
      return output;
    },
    now: async () => Date.now(),
    async approval(title, req, at) {
      if (dropped.aborted) return halted();
      const checked = checkApproval(title, req);
      const state: ApprovalState = {
        id: `approval-${run.approvals.length + 1}`,
        title,
        approver: checked.approver,
        ...(checked.links && { links: checked.links }),
        ...(checked.details !== undefined && { details: checked.details }),
        requestedBy: "workflow",
        covers: checked.covers,
        status: "pending",
        requestedAt: Date.now(),
        refused: [],
      };
      run.approvals.push(state);
      write(
        run,
        {
          type: "approval.requested",
          approval: state.id,
          ...at,
          title,
          approver: state.approver,
          requestedBy: "workflow",
          covers: state.covers,
        },
        { key: state.id },
      );
      run.status = "waiting";
      const decision = await decide(state);
      if (decision !== "approve" && decision !== "reject") {
        throw new SanomaError("invalid_input", `decide answered ${String(decision)}, not "approve" or "reject"`, {
          approval: state.id,
        });
      }
      run.status = "running";
      // The approver decides: the person named, or for a group, the group's name.
      const by = typeof state.approver === "string" ? state.approver : state.approver.group;
      const decidedAt = Date.now();
      Object.assign(state, { status: decision === "approve" ? "approved" : "rejected", decidedBy: by, decidedAt });
      write(run, { type: "approval.decided", approval: state.id, decision, by }, { key: state.id });
      if (decision === "reject") throw new RejectedError(title, { id: by }, undefined, state.id);
      return { approvedBy: by, at: decidedAt };
    },
    async sleep(raw, at) {
      if (dropped.aborted) return halted();
      const until = untilOf(checkSleep(raw), Date.now());
      write(run, { type: "sleep.started", ...at, until });
      await waitUntil(until, dropped);
    },
    async all(list, at) {
      if (dropped.aborted) return halted();
      // Nested, or two at once: either way the members' records would not read as one fan-out.
      if (run.group) {
        throw new SanomaError(
          "invalid_input",
          "a ctx.all is already running: await it before the next, and call none inside one",
          { group: run.group.id },
        );
      }
      const members = parseOrThrow(AllMembers, list, "ctx.all");
      const id = `all:${run.seq}`;
      const outputs: unknown[] = [];
      try {
        for (const [index, member] of members.entries()) {
          run.group = { id, index, size: members.length, ...(at.node && { node: at.node }) };
          outputs.push(await member());
        }
      } finally {
        delete run.group;
      }
      return outputs;
    },
  });

  /** Starts a run of the workflow, or answers the run the id already names. */
  const start = (wf: WorkflowDefinition<any, any>, input: unknown, id = `page:${++started}`): string => {
    // Checked before there is a run, as a worker's start checks it.
    const parsed = parseOrThrow(wf.input, input, `The input does not match ${wf.name}'s schema`);
    const seen = runs.get(id);
    if (seen && (seen.workflow !== wf.name || !dequal(seen.input, input))) {
      throw new SanomaError(
        "invalid_input",
        `Run ${id} was started as another run: of ${seen.workflow}, with its own input`,
        {
          runId: id,
        },
      );
    }
    if (seen) return id;
    const run: PageRun = {
      id,
      workflow: wf.name,
      input,
      actor,
      status: "running",
      createdAt: Date.now(),
      seq: 0,
      records: [],
      approvals: [],
      done: Promise.resolve(),
    };
    runs.set(id, run);
    const runner = runnerOf(run, current, dropping.signal);
    write(run, { type: "run.started", input });
    run.done = (async () => {
      try {
        const output = await wf.run(ctxOf(wf, run, runner), parsed);
        write(run, { type: "run.finished", output });
        run.status = "finished";
        return output;
      } catch (err) {
        write(run, { type: "run.failed", error: errorInfo(err) });
        Object.assign(run, { status: "failed", error: errorMessage(err) });
        throw err;
      } finally {
        run.updatedAt = Date.now();
      }
    })();
    // Its failure is the run's outcome, read by `.result`: never an unhandled rejection.
    run.done.catch(() => {});
    return id;
  };

  const summary = (run: PageRun): RunSummary => ({
    runId: run.id,
    workflow: run.workflow,
    status: run.status,
    startedBy: run.actor,
    createdAt: run.createdAt,
    ...(run.updatedAt !== undefined && { updatedAt: run.updatedAt }),
    approvals: run.approvals,
    ...(run.error !== undefined && { error: run.error }),
  });

  /** The workflow's runs, newest first. */
  const runsOf = (workflow: string) => [...runs.values()].filter((r) => r.workflow === workflow).toReversed();

  /** The workflow's run of that id: a run of another workflow is none. */
  const runOf = (workflow: string, input: unknown): PageRun => {
    const { runId } = parseOrThrow(RunRef, input ?? {}, "The input");
    const run = runs.get(runId);
    if (!run || run.workflow !== workflow)
      throw new SanomaError("run_not_found", `No run ${runId} of ${workflow}`, { runId });
    return run;
  };

  /** Drops the runs started so far: what `stop` does, and `reset` before it seeds again. */
  const stop = () =>
    dropping.abort(new SanomaError("run_ended", "The page's runs were dropped: it was reset, or its demo unmounted"));

  return {
    async transport({ name, input, id }) {
      // As the app's `CallRequest` takes it: never a run id of the page's own (`page:<n>`).
      if (id !== undefined && !/^[\w-]{1,200}$/.test(id)) {
        throw new SanomaError("invalid_input", "An id is letters, digits, _ and -", { id });
      }
      const op = ops.get(name);
      if (op) {
        if (!isDirect(op, types)) {
          throw new SanomaError(
            "invalid_input",
            `${name} cannot be called directly: it is a workflow's to call: start one that uses it`,
            {
              op: name,
            },
          );
        }
        const runId = `direct:${actor.id}:${id ?? `page:${++started}`}`;
        return callFake(current, op, inputOf(op, input ?? {}), {
          idempotencyKey: runId,
          runId,
          opId: op.id,
          attempt: 1,
          principal: actor,
          by: actor.id,
        });
      }
      const [api = "", method = "start", ...rest] = name.split(".");
      const wf = rest.length ? undefined : byApi.get(api);
      if (!wf) throw new SanomaError("invalid_input", `${name} is no operation or workflow this page runs`, { name });
      switch (method) {
        case "start":
          return { runId: start(wf, input, id) };
        case "result": {
          // As the app's: a run still going after `waitMs` is `run_running`, which `createApi` asks again on.
          const { waitMs } = parseOrThrow(ResultRef, input ?? {}, "The input");
          const run = runOf(wf.name, input);
          if (waitMs === undefined || isEnded(run.status)) return run.done;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const running = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new SanomaError("run_running", `Run ${run.id} is still running`, { runId: run.id })),
              Math.min(waitMs, MAX_DELAY),
            );
          });
          return Promise.race([run.done, running]).finally(() => clearTimeout(timer));
        }
        case "latest": {
          const run = runsOf(wf.name).find((r) => r.status === "finished");
          return run ? { runId: run.id, output: await run.done, at: run.updatedAt! } : null;
        }
        case "runs": {
          const { limit = 20 } = parseOrThrow(RunsLimit, input ?? {}, "The input");
          return runsOf(wf.name).slice(0, limit).map(summary);
        }
        case "approvals":
          return runOf(wf.name, input).approvals;
        case "ledger":
          return runOf(wf.name, input).records.toSorted((a, b) => a.seq - b.seq);
        default:
          throw new SanomaError("invalid_input", `${name} is no operation or workflow this page runs`, { name });
      }
    },
    async reset() {
      stop();
      const seeded = await make();
      // Again after the seeding: a run started while it seeded, or under another reset that ended first, goes too.
      stop();
      current = seeded;
      runs = new Map();
      dropping = new AbortController();
    },
    stop,
  };
}
