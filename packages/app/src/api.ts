import type { ApprovalState, LedgerRecord, RunSummary } from "@sanoma/workflows";

/**
 * The shapes the app's HTTP API sends and receives. The page imports this file too,
 * so the server and the browser agree on them.
 */

/** Who is asking. There is no login: the page asks once and sends the name with every request. */
export const ACTOR_HEADER = "x-sanoma-actor";

/** `GET /api/runs/:id` */
export interface RunDetail {
  run: RunSummary;
  /** The run's ledger records in `seq` order, or null when the config has no ledger store. */
  ledger: LedgerRecord[] | null;
  /** Why the ledger could not be read, when it could not. `ledger` is then empty. */
  ledgerError?: string;
  approvals: ApprovalState[];
}

/** `POST /api/runs` */
export interface StartRunRequest {
  workflow: string;
  input: unknown;
}

export interface StartRunResponse {
  runId: string;
}

/** `POST /api/runs/:id/approvals/:approvalId`. The response is the approval's `ApprovalState`. */
export interface DecideRequest {
  decision: "approve" | "reject";
  note?: string;
}

/** A schema problem with a run's input, as zod reports it. `path` leads to the field. */
export interface InputIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

/** Every error response. */
export interface ErrorResponse {
  error: string;
  /** For a 400 from `POST /api/runs`: what is wrong with the input. */
  issues?: InputIssue[];
  /** For a 403 on a decision: who may decide. */
  approver?: string;
}
