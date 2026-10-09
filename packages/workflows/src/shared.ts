import type { ApprovalState, Approver, Principal } from "./define.ts";

// Types only: resource types as a UI reads them. Erased from the bundle.
export type { Declared, Declaring, References, Resource, ResourceFields, ResourceSpec } from "./resource.ts";
export type { DeclaredResource, ResourceRef } from "./resources.ts";

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
