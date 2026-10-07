import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildCtx, isInfrastructureError } from "./call.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import type { WorkflowDefinition } from "./define.ts";
import { errorInfo, errorMessage } from "./errors.ts";
import { entry, memoryLedger, skipped, write, writeFailure } from "./ledger.ts";
import { warn } from "./log.ts";
import type { Run, RunArgs, WorkerState } from "./run.ts";

export interface Worker {
  stop(): Promise<void>;
}

// DBOS registrations are process-wide and survive shutdown, so a registered function reads
// the state of the worker running when a run starts, and the run keeps that state.
let current: WorkerState | undefined;
const registered = new Map<
  string,
  { definition: WorkflowDefinition<any, any>; fn: (args: RunArgs) => Promise<unknown> }
>();

/** Registers the workflows, connects to Postgres and recovers any runs that were interrupted. */
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

export async function startWorker(config: SanomaConfig, options: WorkerOptions = {}): Promise<Worker> {
  // Check everything before touching the state a running worker reads.
  const resolved = resolveConfig(config);
  for (const wf of resolved.workflows) {
    const other = registered.get(wf.name)?.definition;
    if (other && other !== wf) {
      throw new Error(
        `Two different workflow definitions are named "${wf.name}"; a name can be registered once per process`,
      );
    }
  }
  if (!resolved.ledger) {
    warn("the config has no ledger, so records are kept in memory only and a separate client cannot read them");
  }
  const state: WorkerState = {
    app: resolved.appName,
    ops: resolved.ops,
    drivers: resolved.drivers,
    policy: resolved.policy,
    ...(resolved.policyVersion === undefined ? {} : { policyVersion: resolved.policyVersion }),
    ledger: resolved.ledger ?? memoryLedger(),
    stopped: false,
  };
  for (const wf of resolved.workflows) {
    if (!registered.has(wf.name)) registered.set(wf.name, { definition: wf, fn: register(wf) });
  }
  // Runs recovered during launch start before it returns, so they must already find this
  // state. If the launch fails, a worker still running in the process gets its own back.
  const previous = current;
  current = state;
  try {
    DBOS.setConfig({
      name: resolved.appName,
      systemDatabaseUrl: resolved.databaseUrl,
      logLevel: options.logLevel ?? "warn",
      applicationVersion: resolved.version,
    });
    await DBOS.launch();
  } catch (err) {
    current = previous;
    throw err;
  }
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
  return {
    async stop() {
      state.stopped = true;
      await DBOS.shutdown();
    },
  };
}

/**
 * Warns about unfinished runs this worker will never pick up: started on another version of
 * the app, or queued on another queue (such as the single "sanoma" queue before queues were
 * named per app).
 */
async function warnAboutStrandedRuns({ appName, version, queueName }: ResolvedConfig) {
  const runs = await DBOS.listWorkflows({
    status: ["PENDING", "ENQUEUED"],
    applicationName: appName,
    loadInput: false,
    loadOutput: false,
  });
  const otherVersion = runs.filter((r) => r.applicationVersion && r.applicationVersion !== version);
  // Recovery moves a worker's own runs to DBOS's internal queues, which are fine.
  const otherQueue = runs.filter(
    (r) => !otherVersion.includes(r) && r.queueName && r.queueName !== queueName && !r.queueName.startsWith("_dbos_"),
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

function register(wf: WorkflowDefinition<any, any>) {
  return DBOS.registerWorkflow(
    async ({ input, startedBy }: RunArgs) => {
      const state = current;
      if (!state) throw new Error(`Run of "${wf.name}" started with no worker running`);
      const run: Run = {
        id: DBOS.workflowID!,
        workflow: wf.name,
        actor: startedBy,
        approvals: [],
        seq: 0,
        tail: Promise.resolve(),
        state,
      };
      await write(run, entry(run, { type: "run.started", input }));
      let output: unknown;
      try {
        output = await wf.run(buildCtx(wf, run), wf.input.parse(input));
      } catch (err) {
        const record = entry(run, { type: "run.failed", error: errorInfo(err) });
        if (isInfrastructureError(err)) skipped(record, `the run was interrupted by DBOS (${errorMessage(err)})`);
        else if (state.stopped) skipped(record, "its worker has stopped; the recovered run records the outcome");
        else await writeFailure(run, record, err);
        throw err;
      }
      await write(run, entry(run, { type: "run.finished", output }));
      return output;
    },
    { name: wf.name },
  );
}
