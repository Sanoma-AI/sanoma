import type { Principal } from "./define.ts";

/**
 * Why something failed, as a stable string a caller can branch on. Messages are for people
 * and may change; codes are the contract.
 */
export type ErrorCode =
  | "policy_denied"
  | "approval_rejected"
  | "not_approver"
  | "no_pending_approval"
  | "already_decided"
  | "run_not_found"
  | "driver_failed"
  | "invalid_input"
  | "run_ended";

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "policy_denied",
  "approval_rejected",
  "not_approver",
  "no_pending_approval",
  "already_decided",
  "run_not_found",
  "driver_failed",
  "invalid_input",
  "run_ended",
]);

/**
 * An error with a `code` and plain-JSON `data`, both own enumerable properties, so they survive
 * the trip through DBOS: a run's error is stored serialized and comes back as a new object that
 * is not an instance of this class. Read the code with `errorCode`, never `instanceof`.
 */
export class SanomaError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, data: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "SanomaError";
    this.code = code;
    this.data = data;
  }
}

/** The error's code, read from its own `code` property, or undefined when it has none of ours. */
export function errorCode(e: unknown): ErrorCode | undefined {
  if (typeof e !== "object" || e === null || !Object.hasOwn(e, "code")) return undefined;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" && CODES.has(code) ? (code as ErrorCode) : undefined;
}

/** Thrown into the run when the policy denies an operation call. The run fails with it. */
export class PolicyDeniedError extends SanomaError {
  constructor(op: string, reason: string) {
    super("policy_denied", `${op} was denied by policy: ${reason}`, { op, reason });
    this.name = "PolicyDeniedError";
  }
}

/** Thrown into the run when an approver rejects. The run fails with it. */
export class RejectedError extends SanomaError {
  /**
   * @param title The approval's title.
   * @param by Who rejected it.
   * @param approvalId The approval's id in the run, such as "approval-2".
   */
  constructor(title: string, by: Principal, note: string | undefined, approvalId: string) {
    super("approval_rejected", `"${title}" was rejected by ${by.id}${note ? `: ${note}` : ""}`, {
      title,
      by,
      ...(note === undefined ? {} : { note }),
      approvalId,
    });
    this.name = "RejectedError";
  }
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A zod issue as the ledger and an API can carry it: no symbols in the path. */
export interface InputIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

/** An `invalid_input` error from zod issues, with the issues in `data` and a one-line message. */
export function invalidInput(
  what: string,
  zodIssues: readonly { path: PropertyKey[]; message: string; code: string }[],
  data: Record<string, unknown> = {},
): SanomaError {
  const issues: InputIssue[] = zodIssues.map(({ path, message, code }) => ({
    path: path.filter((p): p is string | number => typeof p !== "symbol"),
    message,
    code,
  }));
  const said = issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  return new SanomaError("invalid_input", `${what}: ${said}`, { ...data, issues });
}

/** What the ledger keeps of an error. */
export interface ErrorInfo {
  code?: ErrorCode;
  name: string;
  message: string;
}

export function errorInfo(err: unknown): ErrorInfo {
  const code = errorCode(err);
  return {
    ...(code === undefined ? {} : { code }),
    name: err instanceof Error ? err.name : "Error",
    message: errorMessage(err),
  };
}
