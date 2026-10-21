import { z } from "zod";
import { type ApprovalState, Approver, Covers, type Principal, sameApprover } from "./define.ts";
import type { Effect, Op } from "./op.ts";

/** An operation as a policy sees it: plain data, without its schemas. */
export type PolicyOp = Pick<Op, "id" | "vendor" | "resource" | "name" | "effect">;

/**
 * An operation as a policy sees it, for a `PolicyCall`: what the runtime passes, so a policy
 * test can build a call from the connector, `{ op: policyOpOf(shop.order.refund), ... }`.
 */
export const policyOpOf = ({ id, vendor, resource, name, effect }: Op): PolicyOp => ({
  id,
  vendor,
  resource,
  name,
  effect,
});

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
  /** Where the call is decided: a run's start, an operation node (the default), a direct call, an approval's decision, a view. */
  mount?: Mount;
  /** For a collection's `save` or `delete`: the record as it was, when there was one. */
  before?: unknown;
}

/** Where a principal's intent is decided: the places the one authorization step is mounted. */
export type Mount = "start" | "node" | "direct" | "decide" | "view";

/**
 * A policy's answer. `reasons` say why, for whoever reads the ledger; they change nothing
 * about what happens to the call.
 */
export type Decision =
  | ({ kind: "allow"; reasons?: string[] } & DecidingRule)
  | ({ kind: "deny"; reason: string; reasons?: string[] } & DecidingRule)
  | ApproveDecision;

/** The rule that decided, for whoever reads the ledger or the Inbox: a Cedar policy's id, and its `@title`. */
interface DecidingRule {
  rule?: string;
  title?: string;
}

/**
 * Hold the call until the approver decides: a person's id, or `{ group }` for anyone in it.
 * The approval covers the held operation, and `covers` adds others, so a policy can let their
 * later calls through once it is approved.
 */
interface ApproveDecision extends DecidingRule {
  kind: "approve";
  approver: Approver;
  covers?: Op[];
}

const ReasonList = z.array(z.string(), { error: "reasons must be a list of strings" }).optional();
const RuleFields = {
  rule: z.string({ error: "the rule must be a string" }).optional(),
  title: z.string({ error: "the title must be a string" }).optional(),
};

/**
 * Checks a policy's answer. Parsing also copies it, so nothing else the policy returned is kept,
 * and turns `covers` into op ids.
 */
export const DecisionSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("allow"), reasons: ReasonList, ...RuleFields }),
    z.object({
      kind: z.literal("deny"),
      reason: z.string({ error: "deny needs a reason" }),
      reasons: ReasonList,
      ...RuleFields,
    }),
    z.object({ kind: z.literal("approve"), approver: Approver, covers: Covers, ...RuleFields }),
  ],
  { error: "not a decision" },
);

/**
 * A decision as checked and as the ledger records it: `covers` by op id, the `rule` that decided
 * and its `title` when the policy names them (a Cedar policy's id and `@title`), and the
 * `version` of the policy that made it, when it has one.
 */
export type RecordedDecision = z.output<typeof DecisionSchema> & { policyVersion?: string };

export const allow = (reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "allow" } : { kind: "allow", reasons };
export const deny = (reason: string, reasons?: string[]): Decision =>
  reasons === undefined ? { kind: "deny", reason } : { kind: "deny", reason, reasons };

/** Holds the call for `approver`. `covers` lists other operations the approval also stands for. */
export function approve(approver: Approver, { title, covers }: { title?: string; covers?: Op[] } = {}): Decision {
  return {
    kind: "approve",
    approver,
    ...(title === undefined ? {} : { title }),
    ...(covers === undefined ? {} : { covers }),
  };
}

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
  /** A Cedar policy's rules (`cedarPolicy`), for the app to show; none for a function. */
  readonly rules?: readonly PolicyRule[];
  /** What the policy would answer before the call is made, with parts of it unknown (`PreviewRequest`). */
  readonly preview?: (request: PreviewRequest) => Preview;
};

/** One rule of a Cedar policy, read from its text: a `forbid` with `@hold` holds, one without denies. */
export interface PolicyRule {
  id: string;
  /** Where it is written, relative to the repo's root, such as `policies/money.cedar`. */
  file?: string;
  effect: "permit" | "forbid";
  /** `@hold(...)`: a group, a person's id, or `on-behalf-of`. */
  hold?: string;
  /** `@title(...)`: the Inbox title of its hold. */
  title?: string;
  /** `@reason(...)`: the message of its deny. */
  reason?: string;
}

/**
 * A question asked ahead of a call: may `principal` take `action` (an operation's id,
 * `workflow:<name>`, `site:<name>` or `collection:<name>`) on `resource` (an operation's target),
 * with the parts of the context given, the rest unknown.
 */
export interface PreviewRequest {
  principal: Principal;
  action: string;
  resource?: string;
  context?: Partial<{
    input: unknown;
    before: unknown;
    run: { id: string; workflow: string };
    approverGroups: string[];
    approvedBy: string[];
    mount: Mount;
  }>;
}

/**
 * A preview's answer: `depends` when the unknown parts decide it, `custom` for a policy written as
 * a function, which cannot be asked ahead.
 */
export type Preview = "allow" | "deny" | "hold" | "depends" | "custom";

/** A policy, optionally named with a version so a reader can tell which rules decided a call. */
export function definePolicy(
  policy: (call: PolicyCall) => Decision | Promise<Decision>,
  options: { version?: string } = {},
): Policy {
  if (typeof policy !== "function") throw new Error("definePolicy expects a function of the call");
  if (options.version !== undefined && (typeof options.version !== "string" || !options.version.trim())) {
    throw new Error("definePolicy: `version` must be a non-empty string");
  }
  const defined = Object.assign((call: PolicyCall) => policy(call), { preview: (): Preview => "custom" });
  return Object.freeze(options.version === undefined ? defined : Object.assign(defined, { version: options.version }));
}

/** Allows every operation call: the policy of a config that names none and has no `policies/*.cedar`. */
export const allowAll: Policy = Object.freeze(Object.assign(() => allow(), { preview: (): Preview => "allow" }));

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
