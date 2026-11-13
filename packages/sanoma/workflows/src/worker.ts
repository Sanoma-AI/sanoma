import { AsyncLocalStorage } from "node:async_hooks";
import { DBOS, Error as DBOSErrors, type ScheduledWorkflowFn } from "@dbos-inc/dbos-sdk";
import type { WorkerApp } from "./app-steps.ts";
import { readApps } from "./apps.ts";
import type { AppSteps } from "./app-workflows.ts";
import { awaitApproval } from "./approvals.ts";
import { buildCtx, decideStart, isInfrastructureError, startHoldOf } from "./call.ts";
import { followBase } from "./change.ts";
import { dbosStatusesOf, SanomaClient } from "./client.ts";
import {
  declaredWakeup,
  envWakeup,
  queueFor,
  type ResolvedConfig,
  resolveConfig,
  type SanomaConfig,
} from "./config.ts";
import { configuredSecrets } from "./credentials.ts";
import {
  type AppBehind,
  type Db,
  DBOS_DATABASE_OPTIONS,
  lazyDb,
  prepareDatabase,
  stampVersion,
  writeAppsBehind,
} from "./db.ts";
import {
  deadlineRegistry,
  type Deadlines,
  declaredRegister,
  envRegister,
  idle,
  onOwnQueue,
  type SelfStop,
  stopWhenIdle,
} from "./deadlines.ts";
import type { WorkflowDefinition } from "./define.ts";
import { credentialsOf, unconfigured, unconfiguredSummary } from "./env.ts";
import { errorCode, errorInfo, parseOrThrow, PolicyDeniedError } from "./errors.ts";
import { entry, ownedLedger, skipped, write, writeFailure } from "./ledger.ts";
import { dbosLogger, info, quietIfSandbox, setLogLevel, warn } from "./log.ts";
import { lineStartsOf, readSource } from "./ast.ts";
import { callsOf, outlineWithSource } from "./outline.ts";
import {
  currentRun,
  recordSandboxChecks,
  type Run,
  type RunArgs,
  type WorkerState,
  type WorkflowOutline,
} from "./run.ts";
import type { DatabasePreparation } from "./op.ts";
import { applyScheduled, nextScheduledFire, type ScheduledStarter, scheduledStarter } from "./schedules.ts";
import type { Source } from "./source.ts";
import { approverLabel, errorMessage, oneAtATime, RENEWAL_AGENT, WORKFLOW_ACTION } from "./shared.ts";
import { renewWhenDue } from "./renewal.ts";

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
  stop(options?: WorkerStop): Promise<void>;
}

/** How `Worker.stop` stops. */
export interface WorkerStop {
  /**
   * For a stop that is not the worker's own (a signal from the host): first registers with its
   * wakeup what the next worker must do, as its own stop would (`StopRule.handOff`), so a run it
   * cut short or a deadline it held is not left until something else wakes the instance. A
   * worker that stops itself never registers this way, nor one that registers with no wakeup.
   */
  register?: boolean;
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
// run keeps that state. Each registered function, by name, is what a schedule fires.
let current: WorkerState | undefined;
const registered = new Map<string, ScheduledWorkflowFn>();

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
   * Loads the company's files again and runs them in a worker of their own, in place of this one, a
   * moment after it is asked: what a save without a remote asks once it merged into the checkout
   * (`AppStepContext.reload`), a column change written without one (`patch`), and a follow of
   * `main` that moved the checkout (`WorkerState.followMain`). `sanoma serve` passes it; without
   * it, the saved code runs once the instance starts again.
   */
  reload?: () => void;
  /**
   * The app's own actions (`sanoma/app/steps`), which its built-in workflows run (Adopt, a
   * form's Save, going live, connecting an existing repository, a chat's turn): the launcher passes
   * them. Without them, a run of one fails, saying this worker runs none of them (`NO_APP_STEPS`,
   * or for a chat `NO_CHAT_STEPS`).
   */
  app?: AppSteps;
  /**
   * How soon a deadline keeps the worker up (`idle`): 60 s by default, so apply's short sleeps
   * and other short waits never stop it.
   */
  idleHorizonMs?: number;
  /** How often a worker with a wakeup (declared, or named by its environment: `envWakeup`) checks whether it may stop: every 15 s by default. */
  stopCheckMs?: number;
  /**
   * Given, and with a wakeup (declared, or named by the environment), the worker stops itself when idle (`stopCheckMs`); without
   * it, nobody would start another, so it never does. Called once the worker has stopped itself, with the deadline it registered with the
   * wakeup (null for none): a supervisor starts a fresh worker on the next write or wake, since a
   * stopped one cannot launch again.
   */
  onStopped?: (stopped: SelfStop) => void;
  /**
   * Apply the workflows' schedules (`trigger: { schedule }`): on by default. `runScenarios` turns
   * it off, on a database of its own, so no schedule is applied there to start a live run.
   */
  schedules?: boolean;
  /**
   * What else the worker prepares the database for at its start, after the runtime's own tables
   * and the connectors' (`ConnectorSetup.prepare`): the launcher passes the staff login's, which
   * no config names. Each gets the database's direct URL.
   */
  prepare?: readonly DatabasePreparation[];
}

/**
 * The async context as this module loaded, in no run: a worker started from inside a run's step (a
 * change's deploy asks the worker to start again, `WorkerOptions.reload`) starts in it, else DBOS
 * would take its calls for the step's (`resumeWorkflows` refuses one in a step) and the worker's
 * timers would keep the step's context for good.
 */
const OUTSIDE_ANY_RUN = AsyncLocalStorage.snapshot();

/**
 * Registers the workflows, connects to Postgres and recovers any runs that were interrupted.
 * When a driver declares variables the environment leaves unset, it first loads their stored
 * values into `process.env` and keeps them current while it runs. It starts whether or not they
 * are all there: it prints one line naming the vendors that lack one (`unconfigured`), and a live
 * call to such a vendor fails, saying why, as the call's own final failure, until they are set.
 */
export function startWorker(config: SanomaConfig, options: WorkerOptions = {}): Promise<Worker> {
  return OUTSIDE_ANY_RUN(() => launchWorker(config, options));
}

/** What `startWorker` does, outside any run. */
async function launchWorker(config: SanomaConfig, options: WorkerOptions): Promise<Worker> {
  // Check everything before touching the state a running worker reads.
  const resolved = resolveConfig(config);
  setLogLevel(options.logLevel);
  // Read once, when it matters: a worker stops itself, registering its next deadline there, only
  // when its caller hears it stop (`onStopped`).
  const declared = options.onStopped || config.wakeup === true ? await declaredWakeup(config) : undefined;
  // Else the one a host Sanoma Cloud made names in the environment, which an instance running the
  // wakeup service ignores: it must not stop.
  const wakeup = declared ?? (options.onStopped && config.wakeup !== true ? envWakeup(process.env) : undefined);
  // The wakeup service wakes the instances that stop: one that runs it must not stop with its worker.
  if (config.wakeup === true && declared) {
    throw new Error(
      "The config runs the wakeup service (`wakeup: true`) and declares a wakeup of its own: an instance that runs the service must not stop, so leave out one of them",
    );
  }
  // The config's own, or a Postgres store made for this worker, which `stop` then closes.
  const ledger = ownedLedger(resolved);
  const secrets = lazyDb(resolved.databaseUrl, "secrets");
  const storedSecrets = configuredSecrets(resolved.secrets, () => secrets.db());
  let stopRule: ReturnType<typeof stopWhenIdle> | undefined;
  let renewing: { close(): Promise<void> } | undefined;
  let stopping: Promise<void> | undefined;
  const horizonMs = options.idleHorizonMs ?? 60_000;
  // The worker's own client, connected by the first step that needs it, for the worker's version: what it starts runs on.
  let client: Promise<SanomaClient> | undefined;
  const appSteps: WorkerApp | undefined = options.app && { steps: options.app, config, resolved };
  const shutdown = new AbortController();
  // One check of the apps' sources at a time; one asked for meanwhile runs once it ends, so the
  // table says what the latest `main` is behind.
  let behind: Promise<void> | undefined;
  let again = false;
  const refreshAppsBehind = () => {
    if (behind) {
      again = true;
      return;
    }
    behind = (async () => {
      do {
        again = false;
        await recordAppsBehind(resolved.root, options.source, state.db, shutdown.signal);
      } while (again && !shutdown.signal.aborted);
      // In the same turn as the last look at `again`, so no ask falls between (it never throws).
      behind = undefined;
    })();
  };
  // Each write waits for the one before it to settle, failed or not.
  const serially = oneAtATime();
  const state: WorkerState = {
    app: resolved.appName,
    connections: resolved.connections,
    ops: resolved.ops,
    drivers: resolved.drivers,
    fakes: resolved.fakes,
    ...(resolved.scenarios && { scenarios: resolved.scenarios }),
    ...(options.source && { source: options.source }),
    ...(options.reload && { reload: options.reload }),
    ...(appSteps && { appSteps }),
    client: () =>
      (client ??= SanomaClient.connect(config, { appVersion: resolved.version }).catch((err: unknown) => {
        // Tried again by the next step: a client that failed to connect is none.
        client = undefined;
        throw err;
      })),
    serially,
    followMain: () =>
      serially(async () => {
        const before = await Promise.resolve(options.source?.head()).catch(() => undefined);
        const moved = await followBase(resolved.remotes, storedSecrets, options.source);
        if ("revision" in moved) {
          refreshAppsBehind();
          // The checkout moved: the worker and the app start again on its files (a merged column change's declaration among them).
          if (moved.revision !== before) options.reload?.();
        }
        return moved;
      }),
    // The runtime's tables, on the secrets' pool: the same database.
    db: () => secrets.db(),
    types: resolved.types,
    declaredObjects: resolved.declaredObjects,
    collections: resolved.collections,
    steps: resolved.steps,
    policy: resolved.policy,
    ...(resolved.root !== undefined && { root: resolved.root }),
    ledger: ledger.store,
    secrets: storedSecrets,
    workflows: resolved.workflows,
    outlines: new Map([...resolved.workflows].map(([name, wf]) => [name, outlineOf(wf)])),
    // `registered` is filled below, before any run starts: every name of this config's is registered then.
    startRun: async (name, runId, args) => {
      const fn = registered.get(name) as unknown as ((args: RunArgs) => Promise<unknown>) | undefined;
      if (!fn) throw new Error(`The worker has no workflow "${name}" to start`);
      // A live apply waits its turn on the apply queue, as the client's do; anything else runs at once.
      const queueName = queueFor(resolved, name, args.sandbox);
      // A built-in run's code, as the client's start sets it, so a worker on another version may carry
      // it: a child (a change's apply and drift, a follow's apply) with its parent, which waits for it.
      const builtInCode = resolved.builtInCodes[name];
      return DBOS.startWorkflow(fn, {
        workflowID: runId,
        ...(queueName && { queueName }),
        ...(builtInCode && { workflowAttributes: { builtInCode } }),
      })(args);
    },
    stopped: false,
    deadlines: deadlineRegistry(),
    shutdown: shutdown.signal,
  };
  const worker: Worker = {
    unconfigured: [...credentialsOf(resolved.driversByVendor, (name) => process.env[name])]
      .filter(([vendor, statuses]) => unconfigured(vendor, statuses))
      .map(([vendor]) => vendor),
    deadlines: state.deadlines,
    async idle() {
      return !state.stopped && idle(state.deadlines, resolved, horizonMs);
    },
    stop(how = {}) {
      // A stop that failed may be tried again.
      return (stopping ??= (async () => {
        stopRule?.close();
        // Before anything closes: it asks whether the worker is idle, as a check does.
        if (how.register) {
          await stopRule
            ?.handOff()
            .catch((err: unknown) => warn(`could not register the wakeup before stopping: ${errorMessage(err)}`));
        }
        state.stopped = true;
        // Each is closed whatever the one before did; the first failure is what stop throws.
        let failed: { error: unknown } | undefined;
        for (const close of [
          // A renewal under way finishes on the pools it writes to, before they close.
          async () => renewing?.close(),
          () => DBOS.shutdown(),
          // Once DBOS is down, so a turn's step cut short is recorded nowhere: the next worker settles it.
          async () => shutdown.abort(),
          async () => (await client?.catch(() => undefined))?.close(),
          // Before the pool it writes to closes: the app it checks now, then none.
          async () => behind,
          () => storedSecrets.close(),
          () => resolved.connections.close(),
          () => resolved.identityProvisioning.close(),
          () => secrets.close(),
          () => resolved.connectionStore.close(),
          () => ledger.close(),
          async () => resolved.dataStore?.close(),
        ]) {
          await close().catch((error: unknown) => (failed ??= { error }));
        }
        if (failed) {
          stopping = undefined;
          throw failed.error;
        }
      })());
    },
  };
  // Runs recovered during launch start before it returns, so they must already find this
  // state. If starting fails, a worker still running in the process gets its own back, once
  // DBOS has stopped: until then a run DBOS dispatches finds this state stopped, and is handed back.
  const previous = current;
  let launched = false;
  try {
    await storedSecrets.validate();
    for (const name of resolved.workflows.keys()) {
      if (!registered.has(name)) registered.set(name, register(name));
    }
    current = state;
    // Before DBOS's pool connects, so its connections start with the database's idle-transaction
    // timeout (`DBOS_DATABASE_OPTIONS`); once per process and database.
    await prepareDatabase(resolved.databaseUrl);
    // Then what the connectors and the launcher keep there (a login's tables): the app only reads them.
    for (const prepare of [...resolved.preparations.values(), ...(options.prepare ?? [])])
      await prepare(resolved.databaseUrl);
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
    const isLatest = latest === resolved.version || options.promote === true;
    if (latest !== resolved.version) {
      if (options.promote) await DBOS.setLatestApplicationVersion(resolved.version);
      else {
        warn(
          `this worker runs version ${resolved.version} but the app's latest is ${latest}; ` +
            "runs queued without a version go to the latest. Start with { promote: true } to take them here",
        );
      }
    }
    // The queues, once this worker is the latest when promoted: DBOS updates a queue's settings
    // only for the latest version. How often each is looked at: DBOS's default second, unless a
    // test suite asks for less.
    const pollMs = process.env.SANOMA_QUEUE_POLL_MS;
    if (pollMs && !(Number(pollMs) > 0))
      throw new Error(`SANOMA_QUEUE_POLL_MS is milliseconds above zero, not "${pollMs}"`);
    const polling = pollMs ? { minPollingIntervalMs: Number(pollMs) } : {};
    await Promise.all([
      DBOS.registerQueue(resolved.queueName, polling),
      // One live apply at a time: DBOS counts the running ones in Postgres, of every version.
      DBOS.registerQueue(resolved.applyQueueName, { globalConcurrency: 1, ...polling }),
    ]);
    // Built-in runs move to the latest version only: a rollback's worker, unless promoted, leaves them be.
    if (isLatest) await carryBuiltInRuns(resolved, () => secrets.db());
    // The schedules are the latest version's: an older worker leaves them as the newer set them.
    if (isLatest && options.schedules !== false) {
      await applyScheduled(resolved, registered, () => secrets.db());
      // A schedule's next tick is a deadline: a worker that stops when idle registers it with its wakeup.
      state.deadlines.addSource(() => nextScheduledFire(resolved, new Date()));
    }
    // An OAuth grant due for renewal is a deadline, and the renewal agent's call when it comes.
    const { connections } = resolved;
    if (connections.renews) {
      renewing = renewWhenDue({
        renewals: connections.renewals,
        deadlines: state.deadlines,
        renew: async ({ id, vendor, dueAt }) => {
          const runtime = await state.client();
          try {
            await runtime.call(
              "sanoma.connection.refresh",
              { connection: { vendor, $connection: id } },
              { actor: RENEWAL_AGENT, id: `renewal:${id}:${dueAt.toISOString()}` },
            );
          } catch (error) {
            // The policy refuses the agent: no renewal is scheduled again until a call renews the grant.
            if (errorCode(error) === "policy_denied") await connections.renewals.unschedule(id);
            throw error;
          }
        },
      });
    }
    await warnAboutStrandedRuns(resolved);
    // How far each app taken from a source is behind it, fetched in the background: the app reads the table.
    refreshAppsBehind();
    const summary = unconfiguredSummary(worker.unconfigured, resolved.driversByVendor.size);
    if (summary && !options.quiet) warn(summary);
    if (resolved.policyProblems.length && !options.quiet) {
      warn(`the policies do not hold, so every call and start is refused:\n  ${resolved.policyProblems.join("\n  ")}`);
    }
    if (wakeup && options.onStopped) {
      stopRule = stopWhenIdle({
        // The row is one more of the runtime's tables: the secrets' pool, on the same database.
        db: () => secrets.db(),
        register:
          "type" in wakeup
            ? declaredRegister({
                // `resolveConfig` checked the operation is the config's (`checkWakeupOps`).
                op: resolved.ops.get(wakeup.type.wakeup!.register)!,
                fn: resolved.drivers.get(wakeup.type.wakeup!.register),
                secrets: state.secrets,
                wakeup: wakeup.binding ?? wakeup.id,
              })
            : envRegister(wakeup),
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
      await Promise.all([
        storedSecrets.close(),
        resolved.connections.close(),
        resolved.identityProvisioning.close(),
        secrets.close(),
        ledger.close(),
        resolved.dataStore?.close(),
        resolved.connectionStore.close(),
      ]);
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
 * Tells how far each app under `root` taken from a source (its `app.ts` names one) is behind it,
 * fetched now (`Source.behind`), or why that cannot be told: offline, no shared history, a
 * repository that cannot fetch. Written to the runtime's table for the app (`writeAppsBehind`),
 * which then lists no other app. Never throws: a failure is warned about. One at a time, since each
 * fetches into the one checkout; nothing more once `stopped` is aborted, nor written.
 */
async function recordAppsBehind(
  root: string | undefined,
  source: Source | undefined,
  db: () => Promise<Db>,
  stopped: AbortSignal,
) {
  try {
    const told = new Map<string, AppBehind>();
    for (const app of readApps(root).filter((a) => a.source !== undefined)) {
      if (stopped.aborted) return;
      if (!source?.behind) {
        told.set(app.name, { error: "This instance's repository cannot fetch an app's source" });
        continue;
      }
      told.set(
        app.name,
        await source.behind(app.name).then(
          (behind): AppBehind => ({ behind }),
          (err: unknown) => ({ error: errorMessage(err) }),
        ),
      );
    }
    if (!stopped.aborted) await writeAppsBehind(await db(), told);
  } catch (err) {
    warn(`could not tell how far the apps are behind their sources: ${errorMessage(err)}`);
  }
}

/**
 * Takes over the unfinished runs of other versions that wait across a deploy (`stampVersion`'s),
 * keeping each run's id, history and unread messages: those whose code is this worker's
 * (`builtInCodes`), and an apply queued and never started, whatever its code. An apply started on
 * other code is cancelled, since it would hold the apply queue's one place for good. Each carried
 * PENDING run is queued again on its own queue (`resumeWorkflows`). Assumes one live worker per
 * database; a failure is warned about, and the worker starts. See README.md, Versions.
 */
async function carryBuiltInRuns(
  { appName, version, builtInCodes, queueName, applyQueueName }: ResolvedConfig,
  db: () => Promise<Db>,
) {
  try {
    const theirs = (
      await DBOS.listWorkflows({
        workflowName: Object.keys(builtInCodes),
        status: ["PENDING", "ENQUEUED"],
        applicationName: appName,
        loadInput: false,
        loadOutput: false,
      })
    ).filter((r) => r.applicationVersion && r.applicationVersion !== version);
    const onApplyQueue = (r: (typeof theirs)[number]) => r.queueName === applyQueueName;
    const carries = (r: (typeof theirs)[number]) =>
      r.attributes?.builtInCode === builtInCodes[r.workflowName] || (onApplyQueue(r) && r.status === "ENQUEUED");
    const carry = theirs.filter(carries);
    const stranded = theirs.filter((r) => onApplyQueue(r) && !carries(r)).map((r) => r.workflowID);
    if (stranded.length) {
      await DBOS.cancelWorkflows(stranded);
      warn(
        `cancelled ${stranded.length} apply run(s) started on other code, which no worker would run: ${stranded.join(", ")}. Apply again.`,
      );
    }
    if (!carry.length) return;
    const carried = await stampVersion(
      await db(),
      carry.map((r) => r.workflowID),
      version,
    );
    const pending = new Set(carried.filter((r) => r.pending).map((r) => r.id));
    const byQueue = Map.groupBy(
      carry.filter((r) => pending.has(r.workflowID)),
      (r) => (onApplyQueue(r) ? applyQueueName : queueName),
    );
    // One queue at a time, so a failure leaves no other resume unawaited.
    for (const [queue, runs] of byQueue) {
      await DBOS.resumeWorkflows(
        runs.map((r) => r.workflowID),
        { queueName: queue },
      );
    }
    if (carried.length) {
      info(`carried ${carried.length} built-in run(s) onto version ${version}: ${carried.map((r) => r.id).join(", ")}`);
    }
  } catch (err) {
    warn(
      `carrying the built-in runs of other versions onto ${version} failed, so they stay there: ${errorMessage(err)}`,
    );
  }
}

/**
 * Warns about unfinished runs this worker will never pick up: started on another version of
 * the app, or queued on another queue (such as the single "sanoma" queue before queues were
 * named per app, or the sandbox queue before sandbox runs went on the app's).
 */
async function warnAboutStrandedRuns(resolved: ResolvedConfig) {
  const { appName, version, queueName } = resolved;
  const runs = await DBOS.listWorkflows({
    status: dbosStatusesOf("queued", "running"),
    applicationName: appName,
    loadInput: false,
    loadOutput: false,
  });
  const otherVersion = runs.filter((r) => r.applicationVersion && r.applicationVersion !== version);
  // Recovery moves a worker's own runs to DBOS's internal queues, which are fine.
  const otherQueue = runs.filter((r) => !otherVersion.includes(r) && !onOwnQueue(r.queueName, resolved));
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

/**
 * Registers the name with DBOS: its runs take the definition of that name from the running worker.
 * A start passes its `RunArgs`; a schedule's tick passes the time it is for (and DBOS's context).
 */
function register(name: string): ScheduledWorkflowFn {
  const fn = DBOS.registerWorkflow(
    (start: RunArgs | Date) =>
      start instanceof Date
        ? runWorkflow(name, start)
        : quietIfSandbox(start.sandbox !== undefined, () => runWorkflow(name, start)),
    { name, maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS },
  );
  return fn as unknown as ScheduledWorkflowFn;
}

/**
 * One run of the workflow registered as `name`, on the state of the worker running when it
 * starts, counted busy in its deadlines but while it waits: started with its `RunArgs`, or by its
 * schedule for the time `start`, as the `schedule` agent with the input `{}`, the policy deciding
 * that start at the top of the run.
 */
async function runWorkflow(name: string, start: RunArgs | Date): Promise<unknown> {
  const state = current;
  const runId = DBOS.workflowID!;
  if (!state) throw new Error(`Run of "${name}" started with no worker running`);
  // A stop's failure is not the run's outcome, but DBOS would record it as one, for good, while
  // its pool is still open. A run's own cancellation it records nothing for: the next worker recovers it.
  // So does a run DBOS dispatches during the stop, as a stopped worker's state stays current until DBOS is down.
  if (state.stopped) throw new DBOSErrors.DBOSWorkflowCancelledError(runId);
  try {
    return await state.deadlines.running(runId, () => runOn(state, name, start));
  } catch (err) {
    if (state.stopped && isInfrastructureError(err, state)) throw new DBOSErrors.DBOSWorkflowCancelledError(runId);
    throw err;
  }
}

async function runOn(state: WorkerState, name: string, start: RunArgs | Date): Promise<unknown> {
  const wf = state.workflows.get(name);
  const outline = state.outlines.get(name);
  // Registered by an earlier worker in this process, whose config had it; this one's has not.
  if (!wf || !outline) throw new Error(`Run of "${name}" refused: this worker's config has no workflow of that name`);
  let scheduled: ({ at: Date } & ScheduledStarter) | undefined;
  let args: RunArgs;
  if (start instanceof Date) {
    scheduled = { at: start, ...(await scheduledStarter(state)) };
    args = { input: {}, startedBy: scheduled.startedBy };
  } else args = start;
  const { input, startedBy, sandbox, hold } = args;
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
  await write(
    run,
    entry(run, { type: "run.started", input, ...(scheduled && { scheduledFor: scheduled.at.toISOString() }) }),
  );
  let output: unknown;
  try {
    try {
      // The one parse of the input: the client checked it, but sent it as given.
      const parsed = parseOrThrow(wf.input, input, `The input does not match ${wf.name}'s schema`);
      const action = `${WORKFLOW_ACTION}${wf.name}`;
      /** The policy's answer to this start, in a step; a deny fails the run. */
      const decide = async () => {
        const decision = await DBOS.runStep(
          async () => decideStart(state.policy, wf.name, parsed, startedBy, run.approvals),
          { name: `policy:${action}` },
        );
        if (decision.kind === "deny") throw new PolicyDeniedError(action, decision.reason);
        return decision;
      };
      if (scheduled) {
        if (scheduled.refused) throw new Error(`The schedule agent was not admitted: ${scheduled.refused}`);
        // A schedule has no one to wait for, and its next tick would start another run meanwhile.
        const decision = await decide();
        if (decision.kind === "approve") {
          throw new PolicyDeniedError(
            action,
            `it needs ${approverLabel(decision.approver)} to approve it, and a scheduled start waits for no approval`,
          );
        }
      }
      // The policy held the start: the body waits for each hold's approval in turn, the policy
      // asked again once one is approved, and a rejection or a deny fails the run.
      for (let next = hold; next;) {
        const held = { op: action, input, reasons: next.reasons };
        await awaitApproval(run, next.title, { approver: next.approver, covers: [action] }, undefined, held);
        const decision = await decide();
        next = decision.kind === "approve" ? startHoldOf(wf.name, decision) : undefined;
      }
      if (sandbox !== undefined) {
        // Imported here, so a live worker never loads the Gherkin parser or faker.
        const { seedSandbox } = await import("./sandbox.ts");
        await seedSandbox(run, sandbox, parsed);
      }
      output = await currentRun.run(run, () => wf.run(buildCtx(wf, run), parsed));
    } finally {
      // Before the outcome is written: a call still queued must find the run ended.
      run.ended = true;
    }
  } catch (err) {
    const record = entry(run, { type: "run.failed", error: errorInfo(err) });
    if (isInfrastructureError(err, state)) skipped(record, `the run was interrupted (${errorMessage(err)})`);
    else {
      await writeFailure(run, record, err);
      await recordSandboxChecks(run);
    }
    throw err;
  }
  await write(run, entry(run, { type: "run.finished", output }));
  // Once its outcome is recorded, before DBOS records it, so a page that reads the run ended reads its last checks.
  await recordSandboxChecks(run);
  return output;
}
