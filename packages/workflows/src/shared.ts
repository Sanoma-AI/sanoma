import type { CredentialStatus } from "./config.ts";
import type { ApprovalState, Approver, Principal } from "./define.ts";
import type { ResourceProblem } from "./resources.ts";

// Types only: resource types as a UI reads them. Erased from the bundle.
export type {
  Declared,
  Declaring,
  FieldReference,
  References,
  Resource,
  ResourceFields,
  ResourceSpec,
} from "./resource.ts";
export type { DeclaredResource, ResourceProblem } from "./resources.ts";
export type { DriftField, DriftReport, DriftResult, DriftStatus } from "./drift.ts";
export type { CredentialStatus } from "./config.ts";

// What a UI in the browser may use from the runtime, besides types: `@sanoma/workflows/shared`.
// Nothing here imports DBOS, Node or zod, so a browser bundle can carry it; the runtime uses the
// same functions, so a page answers these questions the way a run does.

/**
 * Where a run is: waiting on the queue, running, waiting for an approval, or ended.
 * `waiting` is `running` with an approval pending.
 */
export type RunStatus = "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled";

/** The statuses of a run that has ended: it reads no more decisions. */
export const ENDED_STATUSES = ["finished", "failed", "cancelled"] as const satisfies readonly RunStatus[];

/** True when the run has finished, failed or been cancelled. */
export const isEnded = (status: RunStatus): boolean => (ENDED_STATUSES as readonly RunStatus[]).includes(status);

/**
 * True when `by` may decide the approval: `by.id` is the approver, or `by.groups` holds the
 * approver group. Pure: everything it reads is already recorded.
 */
export function mayDecide(approval: Pick<ApprovalState, "approver">, by: Principal): boolean {
  const { approver } = approval;
  return typeof approver === "string" ? approver === by.id : (by.groups?.includes(approver.group) ?? false);
}

/** Who may decide, as text: the person's id, or "group <name>". */
export const approverLabel = (approver: Approver): string =>
  typeof approver === "string" ? approver : `group ${approver.group}`;

/** An error's message, or the value as text when it is not an Error. */
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Where a data-file problem is, `file:line:column`; undefined for one that is the config's, with no file. */
export const problemAt = (p: ResourceProblem): string | undefined =>
  p.file === undefined ? undefined : `${p.file}:${p.line}:${p.column}`;

/** Whether a driver's environment variable lets it run: set, or unset and optional. */
export const credentialReady = ({ status, optional }: CredentialStatus): boolean =>
  status === "set" || (status === "missing" && optional);
