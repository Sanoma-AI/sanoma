import type { ApprovalState, Principal, WorkflowDefinition } from "./define.ts";
import type { Fake } from "./fake.ts";
import type { LedgerStore } from "./ledger.ts";
import type { DriverFn, Op } from "./op.ts";
import type { Policy } from "./policy.ts";

/** What the DBOS workflow receives: the workflow's input, who started the run, and for a sandbox run its scenario. */
export interface RunArgs {
  input: unknown;
  startedBy: Principal;
  /** The scenario a sandbox run is seeded from; the run calls the fakes instead of the drivers. */
  sandbox?: string;
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
  /** The drivers' functions, by operation id. */
  drivers: Map<string, DriverFn>;
  /** The fake vendors sandbox runs call, and their functions by operation id. */
  fakes: Fake<any, any>[];
  fakeDrivers: Map<string, DriverFn>;
  /** Where sandbox runs' scenarios are. */
  scenarios?: URL;
  /** The config's workflows, by name, which scenarios name. */
  workflows: Map<string, WorkflowDefinition<any, any>>;
  /** The sandbox run using the fakes, if one is: one at a time, since they share the fakes' state. */
  sandboxRun?: string;
  /** Its `version`, when it has one, is recorded with each of its decisions. */
  policy: Policy;
  ledger: LedgerStore;
  /**
   * Set when the worker stops, before DBOS shuts down. DBOS abandons a stopped worker's run
   * functions, which then fail as their next DBOS call finds the database closed. Such a failure,
   * one with none of our codes, is not recorded: the run recovered on the next worker records
   * how it really ends (see `isInfrastructureError`).
   */
  stopped: boolean;
}

/** What a run keeps in memory. Rebuilt the same way when DBOS replays the run. */
export interface Run {
  id: string;
  workflow: string;
  actor: Principal;
  /** The scenario a sandbox run is seeded from; unset for a live run. */
  sandbox?: string;
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
  state: WorkerState;
}
