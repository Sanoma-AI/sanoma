import { type ApprovalState, type Approver, type Principal, sameApprover } from "./define.ts";
import type { Effect, Op } from "./op.ts";

/** An operation as a policy sees it: plain data, without its schemas. */
export type PolicyOp = Pick<Op, "id" | "vendor" | "resource" | "name" | "effect">;

/** An operation as a policy sees it, for a `PolicyCall`: what the runtime passes. */
export const policyOpOf = ({ id, vendor, resource, name, effect }: Op): PolicyOp => ({
  id,
  vendor,
  resource,
  name,
  effect,
});

/** What a policy sees for each operation a run calls: plain data. */
export interface PolicyCall {
  op: PolicyOp;
  /** The same as `op.effect`. */
  effect: Effect;
  /** The resource instance the call acts on, from the operation's `target`, when it declares one. */
  target?: string;
  /** The operation's input, already checked against its schema. */
  input: unknown;
  /** Who started the run. */
  actor: Principal;
  /**
   * The run so far: a copy of its approvals, including those the policy asked for earlier.
   * A policy request has `requestedBy: "policy"` and the `op` it held.
   */
  run: { id: string; workflow: string; approvals: readonly ApprovalState[] };
  /** For a collection's `save` or `delete`: the record as it was, when there was one. */
  before?: unknown;
}

/**
 * A policy's answer. `reasons` say why, for whoever reads the ledger; they change nothing
 * about what happens to the call.
 */
export type Decision =
  | { kind: "allow"; reasons?: string[] }
  | { kind: "deny"; reason: string; reasons?: string[] }
  | ApproveDecision;

/** Hold the call until the approver decides: a person's id, or `{ group }` for anyone in it. */
interface ApproveDecision {
  kind: "approve";
  approver: Approver;
  title?: string;
  reasons?: string[];
}

/** A decision as the ledger records it, with the `version` of the policy that made it, when it has one. */
export type RecordedDecision = Decision & { policyVersion?: string };

export const allow = (reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "allow" } : { kind: "allow", reasons };
export const deny = (reason: string, reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "deny", reason } : { kind: "deny", reason, reasons };

/** Holds the call for `approver`; `reasons`, the rules that held it, as `allow` and `deny` take them. */
export function approve(approver: Approver, { title, reasons }: { title?: string; reasons?: string[] } = {}): Decision {
  return {
    kind: "approve",
    approver,
    ...(title === undefined ? {} : { title }),
    ...(reasons === undefined ? {} : { reasons }),
  };
}

/**
 * Decides whether a run may make an operation call: allow it, deny it (the run fails), or hold it
 * until someone approves. A company's is made from its Cedar files (`cedarPolicy`); a repo with
 * none has `allowAll`. Each decision is recorded once made, and a replay reuses it, but a call
 * interrupted before that is decided again.
 */
export type Policy = ((call: PolicyCall) => Decision) & {
  /** Names this version of the policy: a hash of the Cedar policies' ids and text. */
  readonly version?: string;
  /** What the policy would answer for each request ahead of the call, its input unknown. */
  readonly preview: (requests: readonly PreviewRequest[]) => PreviewAnswer[];
  /** May `actor` start a run of `workflow` with `input` (the action `workflow:<name>`)? */
  readonly start: (actor: Principal, workflow: string, input: unknown) => Decision;
};

/** A question asked ahead of a call: may `principal` take `action` (an operation, or `workflow:<name>` to start one) on `resource` (an operation's target)? */
export interface PreviewRequest {
  principal: Principal;
  action: { id: string; effect?: Effect };
  resource?: string;
}

/**
 * A preview's answer: `depends` when the unknown input decides it. `rule` is the Cedar policy
 * behind a hold, a deny or a dependence; `approver`, a hold's.
 */
export interface PreviewAnswer {
  answer: "allow" | "hold" | "deny" | "depends";
  rule?: { id: string; file: string; title?: string; reason?: string };
  approver?: Approver;
}

/** A policy that decides every call and start as `decide` does, and previews each as `answer`. */
const decidingAll = (decide: () => Decision, answer: "allow" | "deny"): Policy =>
  Object.freeze(
    Object.assign(decide, {
      start: decide,
      preview: (requests: readonly PreviewRequest[]): PreviewAnswer[] => requests.map(() => ({ answer })),
    }),
  );

/** Allows every operation call and run start: the policy of a repo with no `policies/**\/*.cedar`. */
export const allowAll: Policy = decidingAll(() => allow(), "allow");

/** Refuses every operation call and run start, and previews each as a deny, saying `reason`. */
export const denyAll = (reason: string): Policy => decidingAll(() => deny(reason), "deny");

/**
 * True when an approval in the run was approved, covers the operation, and was addressed to
 * `approver`. Check all three: a workflow can request an approval covering any operation from
 * anyone it names, so an approval's `covers` alone does not say the right person approved.
 */
export function approvedFor(approvals: readonly ApprovalState[], opId: string, approver: Approver): boolean {
  return approvals.some(
    (a) => a.status === "approved" && a.covers.includes(opId) && sameApprover(a.approver, approver),
  );
}
