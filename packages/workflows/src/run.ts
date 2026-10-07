import type { ApprovalState, Principal } from "./define.ts";
import type { LedgerStore } from "./ledger.ts";
import type { DriverFn, Op } from "./op.ts";
import type { Policy } from "./policy.ts";

/** What the DBOS workflow receives: the workflow's input and who started the run. */
export interface RunArgs {
  input: unknown;
  startedBy: Principal;
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
  policy: Policy;
  /** The policy's `version`, recorded with each of its decisions. */
  policyVersion?: string;
  ledger: LedgerStore;
  /**
   * Set when the worker stops. DBOS abandons a stopped worker's run functions, which then fail
   * as their next DBOS call finds the database closed. Such a run must not record `run.failed`:
   * the run recovered on the next worker records how it really ends.
   */
  stopped: boolean;
}

/** What a run keeps in memory. Rebuilt the same way when DBOS replays the run. */
export interface Run {
  id: string;
  workflow: string;
  actor: Principal;
  approvals: ApprovalState[];
  /** The next ledger `seq`. Advanced only outside steps, so a replay counts the same way. */
  seq: number;
  /**
   * The last `ctx` call queued. Each call waits for the one before it, so a run's calls run one
   * at a time, in program order, even under `Promise.all`. Never rejects.
   */
  tail: Promise<unknown>;
  /** Set when the workflow body has returned or thrown. A call still queued then is refused. */
  ended: boolean;
  state: WorkerState;
}
