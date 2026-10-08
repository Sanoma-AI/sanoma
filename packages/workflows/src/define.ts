import { z } from "zod";
import type { Op } from "./op.ts";

/**
 * Who is acting: the person or service that starts a run or decides an approval. `id` is
 * whatever the deployment identifies people by; `groups` are the roles it vouches for.
 */
export interface Principal {
  id: string;
  groups?: string[];
}

export const Principal: z.ZodType<Principal> = z.object({
  id: z.string().regex(/\S/, "id must not be blank"),
  groups: z.array(z.string()).optional(),
});

export type Builtin = "approval" | "sleep";
export type Use = Op | Builtin;

/** Who may decide an approval: one person, by `Principal.id`, or anyone in a group, by `Principal.groups`. */
export type Approver = string | { group: string };

export const Approver: z.ZodType<Approver> = z.union(
  [z.string().regex(/\S/), z.object({ group: z.string().regex(/\S/) })],
  { error: 'needs an approver: a name, or { group: "name" }' },
);

/** `covers` as given (operations), parsed to their ids. */
export const Covers = z
  .array(
    z.object({ id: z.string() }, { error: "covers must be a list of operations" }).transform((op) => op.id),
    {
      error: "covers must be a list of operations",
    },
  )
  .optional();

export interface ApprovalRequest {
  /** Who must approve: a person's id, or `{ group }` for anyone in it. Phase 4 replaces this with a Cedar decision. */
  approver: Approver;
  /**
   * The operations the approval stands for, so a policy can let their calls through once it
   * is approved (`a.covers.includes(op.id)`). None unless given.
   */
  covers?: Op[];
  links?: string[];
  details?: string;
}

/** One approval in a run, as the run sees it. Published as the run's "approvals" event. */
export interface ApprovalState extends Omit<ApprovalRequest, "covers"> {
  id: string;
  title: string;
  /** Who asked: the workflow (`ctx.approval`), or the policy holding an operation call. */
  requestedBy: "workflow" | "policy";
  /**
   * The operations the approval stands for, by id. A policy hold covers the call it held and
   * any `covers` the policy added; a workflow's approval covers the `covers` it named, or none.
   */
  covers: string[];
  /** For a policy request: the operation call held, by op id. */
  op?: string;
  /** For a policy request: the held call's input. */
  input?: unknown;
  status: "pending" | "approved" | "rejected";
  requestedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /** The `id` of the decision message the run decided with, when it had one. */
  decidedWith?: string;
  /**
   * Messages that were ignored: decisions sent by someone who may not decide the approval,
   * and messages that were not a decision. `by` is the sender, when the message named one.
   */
  refused: { by?: string; at: number; reason: string }[];
}

export interface ApprovalResult {
  approvedBy: string;
  at: number;
  note?: string;
}

/**
 * How long `ctx.sleep` waits: until a time (an ISO 8601 date-time with an offset, such as
 * `2026-10-07T09:00:00Z`, or epoch milliseconds), or for a duration whose parts add up. A time
 * already past waits not at all.
 */
export type SleepRequest =
  | { until: string | number }
  | { ms?: number; seconds?: number; minutes?: number; hours?: number; days?: number };

const time = "must be an ISO 8601 date-time with an offset, such as 2026-10-07T09:00:00Z, or epoch milliseconds";
const duration = z.number({ error: "must be a number" }).nonnegative("must not be negative").optional();

/** Checks a `ctx.sleep` request: `options[0]` is the time form, `options[1]` the duration form. */
export const SleepRequest = z.union([
  z.strictObject({
    until: z.union([z.iso.datetime({ offset: true, error: time }), z.number({ error: time })], { error: time }),
  }),
  z.strictObject({ ms: duration, seconds: duration, minutes: duration, hours: duration, days: duration }),
]) satisfies z.ZodType<SleepRequest>;

type OpsOf<U extends readonly Use[]> = Extract<U[number], Op>;

type CtxOps<O extends Op> = {
  readonly [V in O["vendor"]]: {
    readonly [R in Extract<O, { vendor: V }>["resource"]]: {
      readonly [N in Extract<O, { vendor: V; resource: R }>["name"]]: Extract<
        O,
        { vendor: V; resource: R; name: N }
      > extends Op<any, any, any, infer I, infer Out>
        ? (input: I) => Promise<Out>
        : never;
    };
  };
};

interface ApprovalCtx {
  /** Waits, durably, until the approver (or someone in the approver group) approves. Throws `RejectedError` on a rejection. */
  approval(title: string, request: ApprovalRequest): Promise<ApprovalResult>;
}

interface SleepCtx {
  /** Waits, durably, until a time or for a duration. Survives worker restarts. */
  sleep(request: SleepRequest): Promise<void>;
}

interface BaseCtx {
  /** The current time, recorded so replays see the same value. Use instead of `Date.now()`. */
  now(): Promise<number>;
  readonly runId: string;
}

export type Ctx<U extends readonly Use[]> = BaseCtx &
  CtxOps<OpsOf<U>> &
  ("approval" extends U[number] ? ApprovalCtx : unknown) &
  ("sleep" extends U[number] ? SleepCtx : unknown);

export interface WorkflowDefinition<U extends readonly Use[] = readonly Use[], S extends z.ZodType = z.ZodType> {
  readonly kind: "workflow";
  readonly name: string;
  readonly title?: string;
  readonly trigger: "manual";
  readonly input: S;
  /** Every operation and built-in the workflow may call. `ctx` is built from this list and nothing else. */
  readonly uses: U;
  readonly run: (ctx: Ctx<U>, input: z.output<S>) => Promise<unknown>;
}

export function defineWorkflow<const U extends readonly Use[], S extends z.ZodType>(
  def: Omit<WorkflowDefinition<U, S>, "kind">,
): WorkflowDefinition<U, S> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`Workflow name "${def.name}" must be lowercase letters, digits and dashes`);
  }
  return Object.freeze({ kind: "workflow", ...def });
}
