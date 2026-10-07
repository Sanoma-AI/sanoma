import type { ApprovalState, Principal } from "./define.ts";
import type { Effect, Op } from "./op.ts";

/** What a policy sees for each operation a run calls. */
export interface PolicyCall {
  op: Op;
  effect: Effect;
  /** The operation's input, already checked against its schema. */
  input: unknown;
  /** Who started the run. */
  actor: Principal;
  /**
   * The run so far: a copy of its approvals, including those the policy asked for earlier.
   * A policy request has `requestedBy: "policy"` and the `op` it held.
   */
  run: { id: string; workflow: string; approvals: readonly ApprovalState[] };
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
 * `lintWorkflow` checks a policy file for these too. Each decision is recorded once made,
 * and a replay reuses it, but a call interrupted before that is decided again. A policy
 * must not have side effects.
 */
export type Policy = ((call: PolicyCall) => Decision | Promise<Decision>) & {
  /** Names this version of the policy, from `definePolicy(fn, { version })`. */
  readonly version?: string;
};

/** A policy, optionally named with a version so a reader can tell which rules decided a call. */
export function definePolicy(
  policy: (call: PolicyCall) => Decision | Promise<Decision>,
  options: { version?: string } = {},
): Policy {
  if (typeof policy !== "function") throw new Error("definePolicy expects a function of the call");
  if (options.version !== undefined && (typeof options.version !== "string" || !options.version.trim())) {
    throw new Error("definePolicy: `version` must be a non-empty string");
  }
  const defined = (call: PolicyCall) => policy(call);
  return Object.freeze(options.version === undefined ? defined : Object.assign(defined, { version: options.version }));
}

/** Allows every operation call. A config says so explicitly: `policy: allowAll`. */
export const allowAll: Policy = definePolicy(() => allow());
