import type { ConnectionRef, ConnectionRegistry, ConnectionSnapshot } from "./connection.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerApp } from "./app-steps.ts";
import type { SanomaClient } from "./client.ts";
import type { Collection } from "./collection.ts";
import type { DeclaredObjects } from "./config.ts";
import type { Db } from "./db.ts";
import type { DeadlineRegistry } from "./deadlines.ts";
import type { ApprovalState, Approver, Principal, WorkflowDefinition } from "./define.ts";
import type { Fake } from "./fake.ts";
import type { LedgerStore } from "./ledger.ts";
import type { DriverFn, Op } from "./op.ts";
import type { CallNode } from "./outline.ts";
import type { Policy } from "./policy.ts";
import type { Resource } from "./resource.ts";
import type { Secrets } from "./secret.ts";
import type { Source } from "./source.ts";
import type { Steps } from "./steps.ts";

/** What the DBOS workflow receives: the workflow's input, who started the run, and for a sandbox run its scenario. */
export interface RunArgs {
  input: unknown;
  startedBy: Principal;
  /** The scenario a sandbox run is seeded from; the run calls the fakes instead of the drivers. */
  sandbox?: string;
  /**
   * The policy's hold on the start (`workflow:<name>`), as `SanomaClient.start` was answered: the
   * run waits for this approval before its body runs.
   */
  hold?: StartHold;
}

/** A start the policy held: whom it asks, the approval's title, and the rules that held it. */
export interface StartHold {
  approver: Approver;
  title: string;
  reasons?: string[];
}

/**
 * What one `startWorker` call runs with. DBOS registrations are process-wide and outlive a
 * shutdown, so each run takes the state current when it starts and keeps it: a run left over
 * from a stopped worker never reads a newer worker's drivers or policy.
 */
export interface WorkerState {
  connections?: ConnectionRegistry;
  /** The config's `appName`, recorded on every ledger record. */
  app: string;
  /** The operations as the config's connectors declare them, by id. */
  ops: Map<string, Op>;
  /** The drivers' functions, by operation id, each guarded by its driver's `env` (`indexDrivers` in config.ts). */
  drivers: Map<string, DriverFn>;
  /** The makers of the config's fake vendors, by vendor id: a sandbox run makes its own of each when it is seeded. */
  fakes: Map<string, () => Fake<any, any>>;
  /** Where sandbox runs' scenarios are, the resource types their steps may name, and the steps the connectors ship. */
  scenarios?: URL;
  /** The worker's `source`, when it was given one. */
  source?: Source;
  /** The worker's `reload` (`WorkerOptions.reload`), when it was given one. */
  reload?: () => void;
  /** The app's steps (`WorkerOptions.app`): what the app's built-ins run; none without them. */
  appSteps?: WorkerApp;
  /**
   * The worker's own client, connected on first use, for its version (what it starts runs on);
   * closed when the worker stops. What the built-ins' steps tell and read through, never a run's body.
   */
  client(): Promise<SanomaClient>;
  /** Runs `write` once the one before it has settled: the worker's writes to its repository, one at a time. */
  serially<T>(write: () => Promise<T>): Promise<T>;
  /**
   * Fast-forwards the checkout to the host's `main` (`followBase`), one of the worker's writes
   * (`serially`), as a change's deploy and a push to `main` do first; on a new revision, how far
   * each app taken from a source is behind it is checked again, in the background, into the
   * runtime's table (`recordAppsBehind` in worker.ts), as at the worker's start.
   */
  followMain(): Promise<{ revision: string } | { skipped: string } | { error: string }>;
  /** The runtime's tables (`db.ts`): what the worker writes for the app to read, such as a sandbox run's checks. */
  db(): Promise<Db>;
  types: ReadonlyMap<string, Resource>;
  /** The objects the data files declare, read at each call: a workflow's change operation may not aim at one (`refuseDeclared`). */
  declaredObjects(): Promise<DeclaredObjects>;
  /** The collections, by name, which scenarios' steps may name (`data.<name>`). */
  collections: ReadonlyMap<string, Collection>;
  steps: readonly Steps[];
  /** Its `version`, when it has one, is recorded with each of its decisions. */
  policy: Policy;
  /** The config's directory, whose data files declare the people an approval's decider is checked against (`readPeople`). */
  root?: string;
  ledger: LedgerStore;
  /** The stored secrets, for a live run's drivers (`CallContext.secrets`). */
  secrets: Secrets;
  /**
   * The config's workflows by name, the built-in `drift` among them. A run takes its definition
   * from here, by the name it was registered under: a process registers each name with DBOS once,
   * and each worker's config says what it runs. Scenarios name them too.
   */
  workflows: Map<string, WorkflowDefinition<any, any>>;
  /** Each workflow's outline, by name: read once when the worker starts, every run is held to it (`call_not_in_outline`). */
  outlines: Map<string, WorkflowOutline>;
  /**
   * Starts a run of the workflow `name` as `runId` (an id the run already has returns it): how a
   * built-in starts another as its child, as the change run starts apply and drift.
   */
  startRun(name: string, runId: string, args: RunArgs): Promise<{ getResult(): Promise<unknown> }>;
  /**
   * Set when the worker stops, before DBOS shuts down. DBOS abandons a stopped worker's run
   * functions, which then fail as their next DBOS call finds the database closed. Such a failure,
   * one with none of our codes, is not recorded: the run recovered on the next worker records
   * how it really ends (see `isInfrastructureError`).
   */
  stopped: boolean;
  /** Which of its runs are executing and which wait, until when: what the worker's `idle` reads. */
  deadlines: DeadlineRegistry;
  /**
   * Aborted once the worker has stopped, after DBOS is down: what work of its that outlives a DBOS
   * call stops on (a chat turn's agent, the check of the apps behind), recorded nowhere.
   */
  shutdown: AbortSignal;
}

/** What a run keeps in memory. Rebuilt the same way when DBOS replays the run. */
export interface Run {
  id: string;
  workflow: string;
  actor: Principal;
  /** The scenario a sandbox run is seeded from; unset for a live run. */
  sandbox?: string;
  /** A sandbox run's own fakes' functions, by operation id, from `seedSandbox`; unset for a live run. */
  fakeDrivers?: Map<string, DriverFn>;
  /** A sandbox run's own secrets, in memory, from `seedSandbox`; unset for a live run. */
  fakeSecrets?: Secrets;
  /** Synthetic, run-local identities; this resolver never reads production connection records. */
  fakeConnection?: (vendor: string, ref?: ConnectionRef) => ConnectionSnapshot | undefined;
  approvals: ApprovalState[];
  /** The next ledger `seq`. Advanced only outside steps, so a replay counts the same way. */
  seq: number;
  /**
   * The last `ctx` call queued. Each call waits for the one before it, so a run's calls run one
   * at a time, in program order, even under `Promise.all`. Never rejects.
   */
  tail: Promise<unknown>;
  /**
   * Set while a `ctx.all` runs, so a second one started before it settles is refused. The
   * member a call belongs to travels with the call (`currentGroup` in ledger.ts), not here.
   */
  inAll: boolean;
  /** Set when the workflow body has returned or thrown. A call still queued then is refused. */
  ended: boolean;
  /** The workflow's outline, which every `ctx` call is placed in (`placeCall`). */
  outline: WorkflowOutline;
  state: WorkerState;
}

/** What `placeCall` holds a run's `ctx` calls to: the file's lines, so a frame's line and column become an offset, and the outline's call nodes. */
export interface WorkflowOutline {
  file: string;
  /** `lineStartsOf` the file's text, `\n` line endings. */
  lineStarts: readonly number[];
  calls: readonly CallNode[];
}

/**
 * The run whose workflow body is running: what a built-in's own steps read of it (who started
 * it, whether it is a sandbox run, the worker's source and policy), as no `ctx` member gives them.
 */
export const currentRun = new AsyncLocalStorage<Run>();

/** The run whose built-in step is running (`currentRun`): `what` names the step for the error when there is none. */
export function runNow(what: string): Run {
  const run = currentRun.getStore();
  if (!run) throw new Error(`${what} ran outside its run`);
  return run;
}

/**
 * A sandbox run's checks recorded for the app (`recordChecks`, which never throws); nothing for a
 * live run, which never loads `sandbox.ts`, and with it Cucumber.
 */
export async function recordSandboxChecks(run: Run): Promise<void> {
  if (run.sandbox !== undefined) await (await import("./sandbox.ts")).recordChecks(run, run.sandbox);
}
