import { DBOS } from "@dbos-inc/dbos-sdk";
import { randomUUID } from "node:crypto";
import { awaitApproval } from "./approvals.ts";
import { buildCtx, decideStart, isInfrastructureError, startHoldOf } from "./call.ts";
import { dbosStatusesOf } from "./client.ts";
import { declaredWakeup, type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { storedSecrets, watchCredentials } from "./credentials.ts";
import { claimWakeup, DBOS_DATABASE_OPTIONS, lazyPool, prepareDatabase } from "./db.ts";
import { deadlineRegistry, type Deadlines, idle, onOwnQueue, type SelfStop, stopWhenIdle } from "./deadlines.ts";
import type { WorkflowDefinition } from "./define.ts";
import { credentialsOf, unconfigured, unconfiguredSummary } from "./env.ts";
import { errorInfo, parseOrThrow, PolicyDeniedError } from "./errors.ts";
import { entry, ownedLedger, skipped, write, writeFailure } from "./ledger.ts";
import { dbosLogger, quietIfSandbox, setLogLevel, warn } from "./log.ts";
import { lineStartsOf, readSource } from "./ast.ts";
import { callsOf, outlineWithSource } from "./outline.ts";
import { currentRun, type Run, type RunArgs, type WorkerState, type WorkflowOutline } from "./run.ts";
import type { Source } from "./source.ts";
import { errorMessage, WORKFLOW_ACTION } from "./shared.ts";

export interface Worker {
  /**
   * The vendors whose drivers could not run when the worker started, in the config's order: a
   * live call to one fails, saying why (`unconfigured` in env.ts), until its variables are set.
   * The worker names them in one line at start, unless started `quiet`.
   */
  readonly unconfigured: readonly string[];
  /**
   * Its runs' deadlines: each sleeping run's, and the sources added here (a schedule's next
   * fire), which a stop registers the earliest of with the wakeup.
   */
  readonly deadlines: Deadlines;
  /**
   * True when nothing this worker would run can run soon (`idle` in deadlines.ts): no run executing,
   * none queued, every unfinished one blocked in a sleep or an approval, the next deadline past
   * `idleHorizonMs`. False once stopped.
   */
  idle(): Promise<boolean>;
  /** Stops the worker; a second call waits for the first. */
  stop(): Promise<void>;
}

/**
 * How many times DBOS may start a run again before it gives up on it
 * (`MAX_RECOVERY_ATTEMPTS_EXCEEDED`). Every start of a worker counts one for each unfinished run
 * of its version, and a worker that stops when idle starts again at each wake and each request:
 * at one every five minutes, DBOS's default of 100 would fail a run waiting on an approval within
 * nine hours. 100,000 is a year of that; a run that crashes its process at every recovery is still
 * given up on, after as many restarts.
 */
const MAX_RECOVERY_ATTEMPTS = 100_000;

// DBOS registrations are process-wide and survive shutdown, so a name is registered once, and
// its function reads the state of the worker running when a run starts, definition and all; the
// run keeps that state.
let current: WorkerState | undefined;
const registered = new Set<string>();

export interface WorkerOptions {
  /** The least severe level of the runtime's and DBOS's messages to show, for the whole process: `warn` by default. */
  logLevel?: string;
  /**
   * Start without naming the vendors not configured yet (`unconfigured` still does), or the
   * policies' problems: for a worker whose runs use the fakes alone, as `runScenarios`'s, which
   * `sanoma check` reports them beside.
   */
  quiet?: boolean;
  /**
   * Make this worker's version the app's latest, so runs queued without a version come here.
   * A brand-new version becomes the latest on its own; set this only when deliberately starting
   * a worker on a version seen before (a rollback). Off by default, because an old instance
   * restarting during a rolling deploy would otherwise take the new workers' runs.
   */
  promote?: boolean;
  /** The company's repository, which apply commits the lockfile to; the launcher passes its checkout. */
  source?: Source;
  /**
   * How soon a deadline keeps the worker up (`idle`): 60 s by default, so apply's short sleeps
   * and other short waits never stop it.
   */
  idleHorizonMs?: number;
  /** How often a worker whose data files declare a wakeup checks whether it may stop: every 15 s by default. */
  stopCheckMs?: number;
  /**
   * Given, and with a wakeup declared, the worker stops itself when idle (`stopCheckMs`); without
   * it, nobody would start another, so it never does. Called once the worker has stopped itself, with the deadline it registered with the
   * wakeup (null for none) and that registration's generation: a supervisor starts a fresh
   * worker on the next request or wake (`shouldWake`), since a stopped one cannot launch again.
   */
  onStopped?: (stopped: SelfStop) => void;
}

/**
 * Registers the workflows, connects to Postgres and recovers any runs that were interrupted.
 * When a driver declares variables the environment leaves unset, it first loads their stored
 * values into `process.env` and keeps them current while it runs. It starts whether or not they
 * are all there: it prints one line naming the vendors that lack one (`unconfigured`), and a live
 * call to such a vendor fails, saying why, as the call's own final failure, until they are set.
 */
export async function startWorker(config: SanomaConfig, options: WorkerOptions = {}): Promise<Worker> {
  // Check everything before touching the state a running worker reads.
  const resolved = resolveConfig(config);
  setLogLevel(options.logLevel);
  // Read once, when it matters: a worker stops itself, registering its next deadline there, only
  // when its caller hears it stop (`onStopped`).
  const wakeup = options.onStopped || config.wakeup === true ? await declaredWakeup(config) : undefined;
  // The wakeup service wakes the instances that stop: one that runs it must not stop with its worker.
  if (config.wakeup === true && wakeup) {
    throw new Error(
      "The config runs the wakeup service (`wakeup: true`) and declares a wakeup of its own: an instance that runs the service must not stop, so leave out one of them",
    );
  }
  if (!options.quiet) {
    for (const wf of resolved.workflows.values()) {
      if (wf.trigger !== "manual")
        warn(`the workflow ${wf.name} is on a schedule, which the worker does not run yet: start it by hand`);
    }
  }
  // The config's own, or a Postgres store made for this worker, which `stop` then closes.
  const ledger = ownedLedger(resolved);
  const secrets = lazyPool(resolved.databaseUrl, "secrets");
  let stopRule: { close(): void } | undefined;
  let stopping: Promise<void> | undefined;
  const horizonMs = options.idleHorizonMs ?? 60_000;
  const state: WorkerState = {
    app: resolved.appName,
    ops: resolved.ops,
    drivers: resolved.drivers,
    fakes: resolved.fakes,
    ...(resolved.scenarios && { scenarios: resolved.scenarios }),
    ...(options.source && { source: options.source }),
    types: resolved.types,
    collections: resolved.collections,
    steps: resolved.steps,
    policy: resolved.policy,
    ...(resolved.root !== undefined && { root: resolved.root }),
    ledger: ledger.store,
    secrets: storedSecrets(() => secrets.db(), "sanoma"),
    workflows: resolved.workflows,
    outlines: new Map([...resolved.workflows].map(([name, wf]) => [name, outlineOf(wf)])),
    stopped: false,
    deadlines: deadlineRegistry(),
  };
  const credentials = await watchCredentials(resolved.databaseUrl, resolved.driversByVendor);
  const worker: Worker = {
    unconfigured: [...credentialsOf(resolved.driversByVendor, (name) => process.env[name])]
      .filter(([vendor, statuses]) => unconfigured(vendor, statuses))
      .map(([vendor]) => vendor),
    deadlines: state.deadlines,
    async idle() {
      return !state.stopped && idle(state.deadlines, resolved, horizonMs);
    },
    stop() {
      return (stopping ??= (async () => {
        state.stopped = true;
        stopRule?.close();
        // Each is closed whatever the one before did; the first failure is what stop throws.
        let failed: { error: unknown } | undefined;
        for (const close of [
          () => DBOS.shutdown(),
          () => credentials.close(),
          () => secrets.close(),
          () => ledger.close(),
          async () => resolved.dataStore?.close(),
        ]) {
          await close().catch((error: unknown) => (failed ??= { error }));
        }
        if (failed) throw failed.error;
      })());
    },
  };
  // Runs recovered during launch start before it returns, so they must already find this
  // state. If starting fails, a worker still running in the process gets its own back, once
  // DBOS has stopped: until then a run DBOS dispatches finds this state stopped, and is refused.
  const previous = current;
  let launched = false;
  try {
    for (const name of resolved.workflows.keys()) {
      if (!registered.has(name)) {
        register(name);
        registered.add(name);
      }
    }
    current = state;
    // Before DBOS's pool connects, so its connections start with the database's idle-transaction
    // timeout (`DBOS_DATABASE_OPTIONS`); once per process and database.
    await prepareDatabase(resolved.databaseUrl);
    DBOS.setConfig({
      name: resolved.appName,
      systemDatabaseUrl: resolved.databaseUrl,
      ...DBOS_DATABASE_OPTIONS,
      // A logger of our own replaces DBOS's OTLP log export, so only while DBOS exports none (it
      // does on DBOS Cloud); its level is then the threshold `setLogLevel` set, DBOS's own `logLevel` unread.
      ...(process.env.DBOS__CLOUD === "true" ? { logLevel: options.logLevel ?? "warn" } : { logger: dbosLogger }),
      applicationVersion: resolved.version,
    });
    await DBOS.launch();
    launched = true;
    // DBOS gives runs queued without a version only to the app's latest version, which is the
    // newest one registered. A worker started on code seen before (a rollback) is not it.
    const latest = (await DBOS.getLatestApplicationVersion()).versionName;
    if (latest !== resolved.version) {
      if (options.promote) await DBOS.setLatestApplicationVersion(resolved.version);
      else {
        warn(
          `this worker runs version ${resolved.version} but the app's latest is ${latest}; ` +
            "runs queued without a version go to the latest. Start with { promote: true } to take them here",
        );
      }
    }
    await DBOS.registerQueue(resolved.queueName);
    await warnAboutStrandedRuns(resolved);
    const summary = unconfiguredSummary(worker.unconfigured, resolved.driversByVendor.size);
    if (summary && !options.quiet) warn(summary);
    if (resolved.policyProblems.length && !options.quiet) {
      warn(`the policies do not hold, so every call and start is refused:\n  ${resolved.policyProblems.join("\n  ")}`);
    }
    if (wakeup && options.onStopped) {
      const owner = randomUUID();
      await claimWakeup(await secrets.db(), owner);
      const registerId = wakeup.type.wakeup!.register;
      stopRule = stopWhenIdle({
        // The row is one more of the runtime's tables: the secrets' pool, on the same database.
        db: () => secrets.db(),
        owner,
        wakeup: wakeup.binding ?? wakeup.id,
        // `resolveConfig` checked the operation is the config's (`checkWakeupOps`).
        register: { op: resolved.ops.get(registerId)!, fn: resolved.drivers.get(registerId) },
        secrets: state.secrets,
        deadlines: state.deadlines,
        idle: () => worker.idle(),
        everyMs: options.stopCheckMs ?? 15_000,
        stop: () => worker.stop(),
        onStopped: options.onStopped,
      });
    }
  } catch (err) {
    // Once DBOS is launched, the caller gets no worker to stop: stop it here, so no run goes on
    // in a worker nobody holds, and the next startWorker launches afresh.
    let stopFailed: { error: unknown } | undefined;
    if (launched) await worker.stop().catch((error: unknown) => (stopFailed = { error }));
    else {
      await credentials
        .close()
        .catch((e: unknown) => warn(`closing the credentials listener failed: ${errorMessage(e)}`));
    }
    current = previous;
    if (stopFailed) {
      throw new AggregateError(
        [err, stopFailed.error],
        `${errorMessage(err)} (and stopping DBOS failed too: ${errorMessage(stopFailed.error)})`,
        { cause: err },
      );
    }
    throw err;
  }
  return worker;
}

/**
 * The workflow's outline, read from its file, which every run is held to. A workflow whose
 * outline cannot be read does not start: nothing could say where its calls are.
 */
function outlineOf(wf: WorkflowDefinition<any, any>): WorkflowOutline {
  const { outline, source } = outlineWithSource(wf, readSource(wf.file));
  if ("error" in outline) {
    throw new Error(
      `Workflow "${wf.name}" cannot be outlined, so its runs could not be held to its code: ${outline.error}`,
    );
  }
  return { file: outline.file, lineStarts: lineStartsOf(source!), calls: callsOf(outline.nodes) };
}

/**
 * Warns about unfinished runs this worker will never pick up: started on another version of
 * the app, or queued on another queue (such as the single "sanoma" queue before queues were
 * named per app, or the sandbox queue before sandbox runs went on the app's).
 */
async function warnAboutStrandedRuns({ appName, version, queueName }: ResolvedConfig) {
  const runs = await DBOS.listWorkflows({
    status: dbosStatusesOf("queued", "running"),
    applicationName: appName,
    loadInput: false,
    loadOutput: false,
  });
  const otherVersion = runs.filter((r) => r.applicationVersion && r.applicationVersion !== version);
  // Recovery moves a worker's own runs to DBOS's internal queues, which are fine.
  const otherQueue = runs.filter((r) => !otherVersion.includes(r) && !onOwnQueue(r.queueName, queueName));
  if (!otherVersion.length && !otherQueue.length) return;
  const ids = [...otherVersion, ...otherQueue].map((r) => r.workflowID);
  warn(
    `${otherVersion.length} unfinished run(s) of "${appName}" belong to another version and ${otherQueue.length} ` +
      `wait on another queue, so this worker (version ${version}, queue ${queueName}) will not run them: ` +
      `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}. Run the version that started them, or move each ` +
      `with DBOSClient.forkWorkflow(id, step, { applicationVersion: "${version}", queueName: "${queueName}" }) ` +
      `and cancel the original; resumeWorkflow(id, { queueName: "${queueName}" }) moves a run on this version to this queue.`,
  );
}

/** Registers the name with DBOS: its runs take the definition of that name from the running worker. */
function register(name: string) {
  DBOS.registerWorkflow((args: RunArgs) => quietIfSandbox(args.sandbox !== undefined, () => runWorkflow(name, args)), {
    name,
    maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
  });
}

/**
 * One run of the workflow registered as `name`, on the state of the worker running when it
 * starts, counted busy in its deadlines but while it waits.
 */
async function runWorkflow(name: string, args: RunArgs): Promise<unknown> {
  const state = current;
  // A stopped worker's state stays current while DBOS shuts down.
  if (!state || state.stopped) throw new Error(`Run of "${name}" started with no worker running`);
  return state.deadlines.running(DBOS.workflowID!, () => runOn(state, name, args));
}

async function runOn(state: WorkerState, name: string, { input, startedBy, sandbox, hold }: RunArgs): Promise<unknown> {
  const wf = state.workflows.get(name);
  const outline = state.outlines.get(name);
  // Registered by an earlier worker in this process, whose config had it; this one's has not.
  if (!wf || !outline) throw new Error(`Run of "${name}" refused: this worker's config has no workflow of that name`);
  const run: Run = {
    id: DBOS.workflowID!,
    workflow: wf.name,
    actor: startedBy,
    ...(sandbox === undefined ? {} : { sandbox }),
    approvals: [],
    seq: 0,
    tail: Promise.resolve(),
    inAll: false,
    ended: false,
    outline,
    state,
  };
  await write(run, entry(run, { type: "run.started", input }));
  let output: unknown;
  try {
    try {
      // The one parse of the input: the client checked it, but sent it as given.
      const parsed = parseOrThrow(wf.input, input, `The input does not match ${wf.name}'s schema`);
      // The policy held the start: the body waits for each hold's approval in turn, the policy
      // asked again once one is approved, and a rejection or a deny fails the run.
      const action = `${WORKFLOW_ACTION}${wf.name}`;
      for (let next = hold; next;) {
        const held = { op: action, input, reasons: next.reasons };
        await awaitApproval(run, next.title, { approver: next.approver, covers: [action] }, undefined, held);
        const decision = await DBOS.runStep(
          async () => decideStart(state.policy, wf.name, parsed, startedBy, run.approvals),
          {
            name: `policy:${action}`,
          },
        );
        if (decision.kind === "deny") throw new PolicyDeniedError(action, decision.reason);
        next = decision.kind === "approve" ? startHoldOf(wf.name, decision) : undefined;
      }
      if (sandbox !== undefined) {
        // Imported here, so a live worker never loads the Gherkin parser or faker.
        const { seedSandbox } = await import("./sandbox.ts");
        await seedSandbox(run, sandbox);
      }
      output = await currentRun.run(run, () => wf.run(buildCtx(wf, run), parsed));
    } finally {
      // Before the outcome is written: a call still queued must find the run ended.
      run.ended = true;
    }
  } catch (err) {
    const record = entry(run, { type: "run.failed", error: errorInfo(err) });
    if (isInfrastructureError(err, state)) skipped(record, `the run was interrupted (${errorMessage(err)})`);
    else await writeFailure(run, record, err);
    throw err;
  }
  await write(run, entry(run, { type: "run.finished", output }));
  return output;
}
