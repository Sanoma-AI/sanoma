import type { ApprovalState } from "./define.ts";
import type { Effect, Op } from "./op.ts";

/** What a policy sees for each operation a run calls. */
export interface PolicyCall {
  op: Op;
  effect: Effect;
  /** The operation's input, already checked against its schema. */
  input: unknown;
  /** Who started the run. */
  actor: string;
  /** The run so far. `approvals` is the run's own list, including approvals the policy asked for earlier. */
  run: { id: string; workflow: string; approvals: ApprovalState[] };
}

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approve"; approver: string; title?: string };

export const allow = (): Decision => ({ kind: "allow" });
export const deny = (reason: string): Decision => ({ kind: "deny", reason });
export const approve = (approver: string, title?: string): Decision =>
  title === undefined ? { kind: "approve", approver } : { kind: "approve", approver, title };

/**
 * Decides whether a run may make an operation call: allow it, deny it (the run fails),
 * or hold it until someone approves. Runs are replayed after a restart, so a policy must
 * decide the same way every time from the call alone: no clock, randomness or network.
 * `lintWorkflow` checks a policy file for these too.
 */
export type Policy = (call: PolicyCall) => Decision | Promise<Decision>;

export function definePolicy(policy: Policy): Policy {
  if (typeof policy !== "function") throw new Error("definePolicy expects a function of the call");
  return Object.freeze(policy);
}

/** Thrown into the run when the policy denies an operation call. The run fails with it. */
export class PolicyDeniedError extends Error {
  override readonly name = "PolicyDeniedError";
  readonly op: string;
  readonly reason: string;

  constructor(op: string, reason: string) {
    super(`${op} was denied by policy: ${reason}`);
    this.op = op;
    this.reason = reason;
  }
}
