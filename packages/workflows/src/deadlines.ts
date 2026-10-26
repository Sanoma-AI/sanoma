import { DBOS } from "@dbos-inc/dbos-sdk";
import { dbosStatusesOf } from "./client.ts";
import type { Db } from "./db.ts";
import { nextWakeupGeneration, recordWakeupRegistration, recordWakeupStop } from "./db.ts";
import type { ResolvedConfig } from "./config.ts";
import { warn } from "./log.ts";
import type { CallContext, DriverFn, Op } from "./op.ts";
import type { Secrets } from "./secret.ts";
import { errorMessage, RUNTIME_AGENTS } from "./shared.ts";
import type { WakeupRegistration } from "./wakeup.ts";

// What a worker knows of its own runs that DBOS cannot tell it: which are executing and which are
// blocked in a `ctx` wait, and until when. DBOS sees both as PENDING. A worker that registers a
// wakeup stops itself once nothing can run before the next deadline (`stopWhenIdle`).

/** What a run blocked in a `ctx` wait waits for: a sleep, until its deadline, or an approval's decision, which has none. */
export type Wait = { kind: "sleep"; until: number } | { kind: "approval" };

/** A deadline besides the sleeping runs', such as a schedule's next fire; undefined for none. */
export type DeadlineSource = () => Date | undefined;

/** What a worker shows of its runs' deadlines (`Worker.deadlines`). */
export interface Deadlines {
  /**
   * Adds a deadline besides the sleeping runs', read each time `nextDeadline` is: a fixed time
   * (a schedule's next fire), never one counted from now, which would never let the worker stop.
   */
  addSource(source: DeadlineSource): void;
  /** The earliest deadline: a sleeping run's `until`, or a source's. Undefined when there is none. */
  nextDeadline(): Date | undefined;
  /** How many runs are inside their body and in no wrapped wait: executing, or replaying. */
  readonly busy: number;
  /** What the run waits for while it is blocked in a wrapped wait; undefined otherwise. */
  waitOf(runId: string): Wait | undefined;
}

/** The registry a worker's runs report to, through `running` and `waiting`. */
export interface DeadlineRegistry extends Deadlines {
  /** Runs a run's body, counted busy but while it is in `waiting`. */
  running<T>(runId: string, body: () => Promise<T>): Promise<T>;
  /** Runs `fn`, the live wait itself (`DBOS.sleep`, `DBOS.recv`), with the run counted as waiting for `wait`. */
  waiting<T>(runId: string, wait: Wait, fn: () => Promise<T>): Promise<T>;
}

/** A registry of its own for each worker: two copies of the package in one process never share one. */
export function deadlineRegistry(): DeadlineRegistry {
  // Each run inside its body, with what it waits for while it is blocked.
  const runs = new Map<string, Wait | undefined>();
  const sources: DeadlineSource[] = [];
  return {
    addSource(source) {
      sources.push(source);
    },
    nextDeadline() {
      const times = [
        ...[...runs.values()].flatMap((wait) => (wait?.kind === "sleep" ? [wait.until] : [])),
        ...sources.flatMap((source) => source()?.getTime() ?? []),
      ];
      return times.length ? new Date(Math.min(...times)) : undefined;
    },
    get busy() {
      return [...runs.values()].filter((wait) => wait === undefined).length;
    },
    waitOf: (runId) => runs.get(runId),
    async running(runId, body) {
      runs.set(runId, undefined);
      try {
        return await body();
      } finally {
        runs.delete(runId);
      }
    },
    async waiting(runId, wait, fn) {
      // Every wait is inside a run's body; one outside is left uncounted rather than counted busy for good.
      if (!runs.has(runId)) return fn();
      runs.set(runId, wait);
      try {
        return await fn();
      } finally {
        if (runs.has(runId)) runs.set(runId, undefined);
      }
    },
  };
}

/** The worker `idle` asks about: the app, the version it runs, and its queue. */
export type IdleScope = Pick<ResolvedConfig, "appName" | "version" | "queueName">;

/**
 * True when a run on `queue` (none for a run started outside a queue) is this worker's to run: on
 * its own queue, or on one of DBOS's, where recovery puts runs.
 */
export const onOwnQueue = (queue: string | undefined, queueName: string): boolean =>
  !queue || queue === queueName || queue.startsWith("_dbos_");

/**
 * True when nothing this worker would run can run within `horizonMs`: no run of its is executing
 * or replaying; none of its version is queued (or queued without one, while it is the latest) on
 * its queue or DBOS's own (recovery queues there); each PENDING run of its version is blocked in
 * a wrapped wait; and the next deadline is past the horizon. A run of another version or queue
 * is not this worker's to run, so it never holds the worker up.
 */
export async function idle(deadlines: Deadlines, scope: IdleScope, horizonMs: number): Promise<boolean> {
  if (deadlines.busy > 0) return false;
  const next = deadlines.nextDeadline();
  if (next && next.getTime() <= Date.now() + horizonMs) return false;
  const runs = await DBOS.listWorkflows({
    applicationName: scope.appName,
    status: dbosStatusesOf("queued", "running"),
    loadInput: false,
    loadOutput: false,
  });
  const ours = runs.filter((r) => onOwnQueue(r.queueName, scope.queueName));
  if (
    ours.some(
      (r) => r.status === "PENDING" && r.applicationVersion === scope.version && !deadlines.waitOf(r.workflowID),
    )
  )
    return false;
  const queued = ours.filter((r) => r.status !== "PENDING");
  if (queued.some((r) => r.applicationVersion === scope.version)) return false;
  // DBOS gives a run queued without a version to the app's latest version.
  if (!queued.some((r) => !r.applicationVersion)) return true;
  return (await DBOS.getLatestApplicationVersion()).versionName !== scope.version;
}

/** What `onStopped` hears when the worker stopped itself: the deadline it registered (null for none) and its generation. */
export interface SelfStop {
  at: string | null;
  generation: number;
}

/** What the stop rule acts on: the wakeup row, the wakeup's register operation, and the worker. */
export interface StopRule {
  /** The wakeup row's database. */
  db: () => Promise<Db>;
  /** This worker's id on the row (`owner`), fresh for each worker. */
  owner: string;
  /** The declared wakeup's binding, else its declaration's id: what scopes a registration's idempotency key to this instance. */
  wakeup: string;
  /** The wakeup type's register operation, and its driver (none when the connector attaches none). */
  register: { op: Op; fn: DriverFn | undefined };
  secrets: Secrets;
  deadlines: Deadlines;
  idle: () => Promise<boolean>;
  everyMs: number;
  /** Stops the worker (`Worker.stop`). */
  stop: () => Promise<void>;
  onStopped?: ((stopped: SelfStop) => void) | undefined;
}

/** Who the runtime calls a wakeup's register as: one of its own agents. */
const WAKEUP_AGENT = "wakeup";
if (!RUNTIME_AGENTS.includes(WAKEUP_AGENT)) throw new Error(`${WAKEUP_AGENT} must be one of RUNTIME_AGENTS`);

/**
 * Checks every `everyMs` whether the worker is `idle`; when it is, counts the wakeup row's
 * generation up, registers the next deadline with the wakeup (none when there is no deadline at
 * all), and stops the worker, then tells `onStopped`. A failed registration is recorded on the
 * row and logged once for each new message, and the worker keeps running: the next check tries
 * again with a new generation. A run that arrives while it registers keeps the worker up, since
 * the worker must be idle twice, with the same deadline, before it stops. `close` ends the checks.
 */
export function stopWhenIdle(rule: StopRule): { close(): void } {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let lastProblem: string | undefined;
  const problem = (message: string) => {
    if (message !== lastProblem) warn(message);
    lastProblem = message;
  };

  const tryStop = async (): Promise<boolean> => {
    if (!(await rule.idle())) return false;
    const next = rule.deadlines.nextDeadline();
    const at = next?.toISOString() ?? null;
    const db = await rule.db();
    const generation = await nextWakeupGeneration(db, rule.owner, at);
    if (generation === undefined) {
      // A worker claims the row only when it starts, so this one never gets it back.
      warn("another worker registers this instance's wakeups now, so this one keeps running and stops checking");
      closed = true;
      return false;
    }
    if (at !== null) {
      try {
        await registerWakeup(rule, { at, generation });
      } catch (err) {
        const message = errorMessage(err);
        await recordWakeupRegistration(db, rule.owner, generation, message);
        problem(`could not register the wakeup at ${at}, so the worker keeps running: ${message}`);
        return false;
      }
      await recordWakeupRegistration(db, rule.owner, generation);
    }
    lastProblem = undefined;
    if (closed || !(await rule.idle()) || rule.deadlines.nextDeadline()?.toISOString() !== next?.toISOString())
      return false;
    await recordWakeupStop(db, rule.owner, generation);
    await rule.stop().catch((err: unknown) => warn(`the worker could not stop cleanly: ${errorMessage(err)}`));
    rule.onStopped?.({ at, generation });
    return true;
  };

  const check = async () => {
    timer = undefined;
    if (closed) return;
    const stopped = await tryStop().catch((err: unknown) => {
      problem(`could not check whether the worker may stop: ${errorMessage(err)}`);
      return false;
    });
    if (!stopped && !closed) schedule();
  };
  const schedule = () => {
    timer = setTimeout(() => void check(), rule.everyMs);
    timer.unref();
  };
  schedule();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Calls the wakeup's register operation, as `SanomaClient.call` calls a driver: its input parsed,
 * a `CallContext` of the runtime's, and no ledger record, which is a run's. The idempotency key
 * is the generation's, so a retried registration is one registration.
 */
async function registerWakeup({ register: { op, fn }, secrets, wakeup }: StopRule, registration: WakeupRegistration) {
  if (!fn) throw new Error(`${op.id} has no driver: the connector package must attach one`);
  // Every database counts generations from 0, so the key names the wakeup too.
  const key = `wakeup:${wakeup}:${registration.generation}`;
  const context: CallContext = { idempotencyKey: key, runId: key, opId: op.id, attempt: 1, secrets, by: WAKEUP_AGENT };
  await fn(op.input.parse(registration), context);
}
