import { AsyncLocalStorage } from "node:async_hooks";
import type { Collection } from "./collection.ts";
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
  types: ReadonlyMap<string, Resource>;
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
   * Set when the worker stops, before DBOS shuts down. DBOS abandons a stopped worker's run
   * functions, which then fail as their next DBOS call finds the database closed. Such a failure,
   * one with none of our codes, is not recorded: the run recovered on the next worker records
   * how it really ends (see `isInfrastructureError`).
   */
  stopped: boolean;
  /** Which of its runs are executing and which wait, until when: what the worker's `idle` reads. */
  deadlines: DeadlineRegistry;
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
