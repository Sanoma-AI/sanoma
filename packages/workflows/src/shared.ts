import type { CredentialStatus } from "./env.ts";
import type { ApprovalState, Approver, Principal } from "./define.ts";
import type { ResourceProblem } from "./resources.ts";
import type { OutlineNode } from "./outline.ts";

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
export type { ApplyPlan, ApplyReport, ApplyResult, PlanAnswer, PlanStep } from "./apply.ts";
export type { CredentialStatus } from "./env.ts";

// What a UI in the browser may use from the runtime, besides types: `@sanoma-ai/workflows/shared`.
// Nothing here imports DBOS, Node or zod, so a browser bundle can carry it; the runtime uses the
// same functions, so a page answers these questions the way a run does.

/**
 * What a `ctx.sleep` without a `{ name }` is called, in its outline node and its ledger record
 * (`name`); a name given may not be it.
 */
export const DEFAULT_SLEEP_NAME = "Sleep";

/** The built-in drift workflow's name, which a config's own workflows may not take; a UI and the scenarios name its runs by it. */
export const DRIFT_WORKFLOW = "drift";

/**
 * The built-in apply workflow's name: the only workflow that may call a writable resource type's
 * change operations (`create`, `update`, `delete`).
 */
export const APPLY_WORKFLOW = "apply";

/**
 * Every run status, in the order a run may pass through them: waiting on the queue, running,
 * waiting for an approval, or ended. `waiting` is `running` with an approval pending.
 */
export const RUN_STATUSES = ["queued", "running", "waiting", "finished", "failed", "cancelled"] as const;

/** Where a run is: one of `RUN_STATUSES`, so a new status reaches every list and map of them. */
export type RunStatus = (typeof RUN_STATUSES)[number];

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

/** True when an outline's op id, a computed segment shown as `*`, could be this op: `a.*.c` fits `a.b.c`. */
export function fitsOp(pattern: string, op: string): boolean {
  const want = pattern.split(".");
  const got = op.split(".");
  return want.length === got.length && want.every((segment, i) => segment === "*" || segment === got[i]);
}

/** A node's child lists, in order: the lists a `path`'s segments index into. */
export const childLists = (node: OutlineNode): OutlineNode[][] => {
  switch (node.kind) {
    case "all":
      return node.branches;
    case "branch":
      return node.cases;
    case "each":
    case "repeat":
      return [node.body];
    case "try":
      return [node.body, node.handler];
    default:
      return [];
  }
};

/** Every node of an outline, nested ones included, in order. */
export function flatten(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node) => [node, ...flatten(childLists(node).flat())]);
}

/** Where a data-file problem is, `file:line:column`; undefined for one that is the config's, with no file. */
export const problemAt = (p: ResourceProblem): string | undefined =>
  p.file === undefined ? undefined : `${p.file}:${p.line}:${p.column}`;

/**
 * A problem as one line: `file:line:column: message`, or `file: message` without a position, or
 * the message alone without a file.
 */
export function problemLine(p: { file?: string; line?: number; column?: number; message: string }): string {
  if (p.file === undefined) return p.message;
  return p.line === undefined ? `${p.file}: ${p.message}` : `${p.file}:${p.line}:${p.column ?? 1}: ${p.message}`;
}

/**
 * Whether a host is this machine: `localhost`, `127.x.x.x` or `::1` (bare, or bracketed as a URL's
 * `hostname` has it). The one rule for what the app listens on and answers to, and for where the
 * bin may start Postgres.
 */
export const isLoopback = (host: string) =>
  ["localhost", "::1", "[::1]"].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Whether a driver's environment variable lets it run: set, or unset and optional. */
export const credentialReady = ({ status, optional }: CredentialStatus): boolean =>
  status === "set" || (status === "missing" && optional);
