import type { ApprovalState, ErrorCode, LedgerRecord, RunSummary } from "@sanoma/workflows";
import { z } from "zod";

/**
 * The shapes the app's HTTP API and server functions send and receive. The page imports this
 * file too, so the server and the browser agree on them. Only types come from
 * `@sanoma/workflows`, so the browser bundle never loads the runtime.
 */

/** Who is asking. There is no login: the page asks once and sends the name with every change. */
export const ACTOR_HEADER = "x-sanoma-actor";

/** `POST /api/runs` */
export const StartRunRequest = z.object({
  workflow: z.string().min(1, "Name a workflow"),
  input: z.unknown(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export interface StartRunResponse {
  runId: string;
}

/** `POST /api/runs/:id/approvals/:approvalId`. The response is the approval's `ApprovalState`. */
export const DecideRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

/** The decide server function's argument: the request plus where it goes. */
export const DecideCall = DecideRequest.extend({ runId: z.string().min(1), approvalId: z.string().min(1) });
export type DecideCall = z.infer<typeof DecideCall>;

/** `GET /api/runs?limit=`: 1 to 500, default 50. */
export const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

/** `GET /api/runs/:id` */
export interface RunDetail {
  run: RunSummary;
  /** The run's ledger records in `seq` order, or null when the config has no ledger store. */
  ledger: LedgerRecord[] | null;
  /** Why the ledger could not be read, when it could not. `ledger` is then empty. */
  ledgerError?: string;
  approvals: ApprovalState[];
}

/** A schema problem with a request or a run's input, as zod reports it. `path` leads to the field. */
export interface InputIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

/** Every error response, and the `body` of an error a server function throws. */
export interface ErrorResponse {
  error: string;
  /** The runtime's code, when the error has one. Branch on this, never on `error`. */
  code?: ErrorCode;
  /** For `invalid_input`: what is wrong with the request or the input. */
  issues?: InputIssue[];
  /** For `not_approver`: who may decide. */
  approver?: ApprovalState["approver"];
}

/** An error with the HTTP status and body the API answers with. */
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

/** The API error body carried by an error (an `ApiError`, here or rebuilt by `unwrap`), when it has one. */
export function errorBodyOf(err: unknown): ErrorResponse | undefined {
  const body = typeof err === "object" && err !== null ? (err as { body?: unknown }).body : undefined;
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
    ? (body as ErrorResponse)
    : undefined;
}

/**
 * What a server function that changes something answers: its value, or the error the API
 * would answer with. Start sends a thrown error to the browser with its message only, so the
 * status and body travel as a value instead.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: ErrorResponse };

/** The outcome's value, or an `ApiError` thrown in the browser with the status and body. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new ApiError(outcome.status, outcome.error);
}

/** Someone who may decide an approval, as text: a name, or "group <name>". */
export function approverName(approver: string | { group: string }): string {
  return typeof approver === "string" ? approver : `group ${approver.group}`;
}
