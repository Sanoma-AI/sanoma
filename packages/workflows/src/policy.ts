import { z } from "zod";
import type { ApprovalState, Principal } from "./define.ts";
import type { Effect, Op } from "./op.ts";

/** An operation as a policy sees it: plain data, without its schemas. */
export type PolicyOp = Pick<Op, "id" | "vendor" | "resource" | "name" | "effect">;

/** What a policy sees for each operation a run calls. Plain data, so a test can build one by hand. */
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
}

/**
 * A policy's answer. `reasons` say why, for whoever reads the ledger; they change nothing
 * about what happens to the call.
 */
export type Decision =
  | { kind: "allow"; reasons?: string[] }
  | { kind: "deny"; reason: string; reasons?: string[] }
  | { kind: "approve"; approver: string; title?: string };

/** A decision as the ledger records it: with the `version` of the policy that made it, when it has one. */
export type RecordedDecision = Decision & { policyVersion?: string };

const ReasonList = z.array(z.string(), { error: "reasons must be a list of strings" }).optional();

/** Checks a policy's answer. Parsing also copies it, so nothing else the policy returned is kept. */
export const Decision: z.ZodType<Decision> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("allow"), reasons: ReasonList }),
    z.object({ kind: z.literal("deny"), reason: z.string({ error: "deny needs a reason" }), reasons: ReasonList }),
    z.object({
      kind: z.literal("approve"),
      approver: z.string({ error: "approve needs an approver" }).regex(/\S/, "approve needs an approver"),
      title: z.string({ error: "the title must be a string" }).optional(),
    }),
  ],
  { error: "not a decision" },
);

export const allow = (reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "allow" } : { kind: "allow", reasons };
export const deny = (reason: string, reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "deny", reason } : { kind: "deny", reason, reasons };
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
