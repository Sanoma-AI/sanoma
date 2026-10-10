import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildCtx, isInfrastructureError } from "./call.ts";
import { dbosStatusesOf } from "./client.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { errorInfo, parseOrThrow } from "./errors.ts";
import { entry, skipped, write, writeFailure } from "./ledger.ts";
import { warn } from "./log.ts";
import type { Run, RunArgs, WorkerState } from "./run.ts";
import { credentialReady, errorMessage } from "./shared.ts";

export interface Worker {
  stop(): Promise<void>;
}

// DBOS registrations are process-wide and survive shutdown, so a name is registered once, and
// its function reads the state of the worker running when a run starts, definition and all; the
// run keeps that state.
let current: WorkerState | undefined;
const registered = new Set<string>();

export interface WorkerOptions {
  logLevel?: string;
  /**
   * Make this worker's version the app's latest, so runs queued without a version come here.
   * A brand-new version becomes the latest on its own; set this only when deliberately starting
   * a worker on a version seen before (a rollback). Off by default, because an old instance
   * restarting during a rolling deploy would otherwise take the new workers' runs.
   */
  promote?: boolean;
}

/** Registers the workflows, connects to Postgres and recovers any runs that were interrupted. */
export async function startWorker(config: SanomaConfig, options: WorkerOptions = {}): Promise<Worker> {
  // Check everything before touching the state a running worker reads.
  const resolved = resolveConfig(config);
  refuseUnconfigured(resolved);
  const state: WorkerState = {
    app: resolved.appName,
    ops: resolved.ops,
    drivers: resolved.drivers,
    fakes: resolved.fakes,
    fakeDrivers: resolved.fakeDrivers,
    ...(resolved.scenarios && { scenarios: resolved.scenarios }),
    policy: resolved.policy,
    ledger: resolved.ledger,
    workflows: resolved.workflows,
    stopped: false,
  };
  for (const name of resolved.workflows.keys()) {
    if (!registered.has(name)) {
      register(name);
      registered.add(name);
    }
  }
  const worker: Worker = {
    async stop() {
      state.stopped = true;
      await DBOS.shutdown();
    },
  };
  // Runs recovered during launch start before it returns, so they must already find this
  // state. If starting fails, a worker still running in the process gets its own back, once
  // DBOS has stopped: until then a run DBOS dispatches finds this state stopped, and is refused.
  const previous = current;
  current = state;
  let launched = false;
  try {
    DBOS.setConfig({
      name: resolved.appName,
      systemDatabaseUrl: resolved.databaseUrl,
      logLevel: options.logLevel ?? "warn",
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
    // Sandbox runs share the worker's fakes, so it runs one at a time; another waits, queued.
    await DBOS.registerQueue(resolved.sandboxQueueName, { workerConcurrency: 1 });
    await warnAboutStrandedRuns(resolved);
  } catch (err) {
    // Once DBOS is launched, the caller gets no worker to stop: stop it here, so no run goes on
    // in a worker nobody holds, and the next startWorker launches afresh.
    let stopFailed: { error: unknown } | undefined;
    if (launched) await worker.stop().catch((error: unknown) => (stopFailed = { error }));
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
 * Refuses a worker whose drivers would fail on their first call: a variable a driver's `env`
 * declares is missing or invalid. One error, naming each vendor and its variables.
 */
function refuseUnconfigured({ credentials }: ResolvedConfig) {
  const vendors = [...credentials].flatMap(([vendor, list]) => {
    const items = list
      .filter((c) => !credentialReady(c))
      .map((c) =>
        c.status === "invalid"
          ? `${c.name} is invalid (${c.problem})`
          : `${c.name} is missing${c.description ? ` (${c.description})` : ""}`,
      );
    return items.length ? [`${vendor}: ${items.join(", ")}`] : [];
  });
  if (vendors.length) {
    throw new Error(`The worker cannot start: ${vendors.join("; ")}. Set them in its environment (locally, in .env)`);
  }
}

/**
 * Warns about unfinished runs this worker will never pick up: started on another version of
 * the app, or queued on another queue (such as the single "sanoma" queue before queues were
 * named per app).
 */
async function warnAboutStrandedRuns({ appName, version, queueName, sandboxQueueName }: ResolvedConfig) {
  const runs = await DBOS.listWorkflows({
    status: dbosStatusesOf("queued", "running"),
    applicationName: appName,
    loadInput: false,
    loadOutput: false,
  });
  const otherVersion = runs.filter((r) => r.applicationVersion && r.applicationVersion !== version);
  // Recovery moves a worker's own runs to DBOS's internal queues, which are fine.
  const otherQueue = runs.filter(
    (r) =>
      !otherVersion.includes(r) &&
      r.queueName &&
      r.queueName !== queueName &&
      r.queueName !== sandboxQueueName &&
      !r.queueName.startsWith("_dbos_"),
  );
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
  DBOS.registerWorkflow(
    async ({ input, startedBy, sandbox }: RunArgs) => {
      const state = current;
      // A stopped worker's state stays current while DBOS shuts down.
      if (!state || state.stopped) throw new Error(`Run of "${name}" started with no worker running`);
      const wf = state.workflows.get(name);
      // Registered by an earlier worker in this process, whose config had it; this one's has not.
      if (!wf) throw new Error(`Run of "${name}" refused: this worker's config has no workflow of that name`);
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
        state,
      };
      await write(run, entry(run, { type: "run.started", input }));
      let output: unknown;
      try {
        try {
          // The one parse of the input: the client checked it, but sent it as given.
          const parsed = parseOrThrow(wf.input, input, `The input does not match ${wf.name}'s schema`);
          if (sandbox !== undefined) {
            // Imported here, so a live worker never loads the Gherkin parser or faker.
            const { seedSandbox } = await import("./sandbox.ts");
            await seedSandbox(run, sandbox);
          }
          output = await wf.run(buildCtx(wf, run), parsed);
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
    },
    { name },
  );
}
