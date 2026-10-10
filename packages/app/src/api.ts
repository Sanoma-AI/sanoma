import type {
  ApprovalState,
  ErrorCode,
  InputIssue,
  LedgerRecord,
  Principal,
  RunStatus,
  RunSummary,
} from "@sanoma/workflows";
import { z } from "zod";

export type { InputIssue } from "@sanoma/workflows";

/**
 * The shapes the app's HTTP API and server functions send and receive. The page imports this
 * file too, so the server and the browser agree on them. Only types come from
 * `@sanoma/workflows`, so the browser bundle never loads the runtime; values the page shares
 * with the runtime come from `@sanoma/workflows/shared`.
 */

/** Who is asking. There is no login: the page asks once and sends the name with every change. */
export const ACTOR_HEADER = "x-sanoma-actor";

/**
 * Who the server says is asking. With a deployment's own `resolveActor` (`fromServer`), it is
 * the deployment's login, which the page shows and cannot change; with the default resolver, it
 * is whatever name the page sends, so the page asks for one and keeps it.
 */
export interface ActorInfo {
  fromServer: boolean;
  /** Null when the request names nobody. */
  actor: Principal | null;
  /** Set when the deployment's `resolveActor` threw: it could not say. */
  error?: string;
}

/** `POST /api/runs` */
export const StartRunRequest = z.object({
  workflow: z.string().min(1, "Name a workflow"),
  input: z.unknown(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export interface StartRunResponse {
  runId: string;
}

/**
 * `POST /api/runs/:id/approvals/:approvalId`. The response is the approval's `ApprovalState`:
 * 200 once the run has read the decision (`status` is `approved` or `rejected`), or 202 with
 * `status` still `pending` when the run did not read it within a few seconds, typically because
 * no worker is running. A 202 decision stays queued, and the run reads it when it next runs.
 * A run that has finished, failed or been cancelled takes no decision: 409 `run_ended`.
 */
export const DecideRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

/** The decide server function's argument: the request plus where it goes. */
export const DecideCall = DecideRequest.extend({ runId: z.string().min(1), approvalId: z.string().min(1) });
export type DecideCall = z.infer<typeof DecideCall>;

/** How many runs one read lists. */
export const RUNS_LIMIT = { default: 50, max: 500 } as const;

const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "finished",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

/** `GET /api/runs?limit=&status=&workflow=`: the latest runs, or the latest with that status, of that workflow. */
export const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_LIMIT.max).default(RUNS_LIMIT.default),
  status: z.enum(RUN_STATUSES).optional(),
  workflow: z.string().min(1).optional(),
});
export type RunsQuery = z.input<typeof RunsQuery>;

/** `GET /api/runs/:id` */
export interface RunDetail {
  run: RunSummary;
  /** The run's ledger records in `seq` order. */
  ledger: LedgerRecord[];
  /**
   * Why the ledger could not be read, when it could not, or why a run that has started has no
   * records there. `ledger` is then empty.
   */
  ledgerError?: string;
  approvals: ApprovalState[];
}

/** Every error response, and the `body` of the error a server function throws. */
export interface ErrorResponse {
  error: string;
  /** The runtime's code, when the error has one. Branch on this, never on `error`. */
  code?: ErrorCode;
  /** For `invalid_input`: what is wrong with the request or the input. */
  issues?: InputIssue[];
  /** For `not_approver`: who may decide. */
  approver?: ApprovalState["approver"];
}

/**
 * An error with the HTTP status and body the API answers with. Every server function fails
 * with one, and the page receives it as one (start.ts registers how it travels).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    super(body.error);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The API error body an error carries, when it is an `ApiError`. */
export const errorBodyOf = (err: unknown): ErrorResponse | undefined =>
  err instanceof ApiError ? err.body : undefined;

/** Who started a run, as text. */
export const starterName = (run: Pick<RunSummary, "startedBy">): string => run.startedBy?.id ?? "unknown";

/** A run's approvals still waiting for a decision. */
export const pendingApprovals = (run: Pick<RunSummary, "approvals">): ApprovalState[] =>
  run.approvals.filter((a) => a.status === "pending");
