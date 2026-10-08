import { z } from "zod";
import type { Op } from "./op.ts";
import { approverLabel } from "./shared.ts";

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

/** Why `by` may not decide the approval, naming who may. */
export const notApprover = ({ approver }: Pick<ApprovalState, "approver">, by: Principal): string =>
  typeof approver === "string"
    ? `${by.id} is not the approver; ${approverLabel(approver)} is`
    : `${by.id} is not in ${approverLabel(approver)}`;

/** True when the two name the same approver: the same id, or the same group. */
export const sameApprover = (a: Approver, b: Approver): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.group === b.group;

const notOps = "covers must be a list of operations";

/** `covers` as given (operations), parsed to their ids. */
export const Covers = z
  .array(
    z.object({ id: z.string() }, { error: notOps }).transform((op) => op.id),
    { error: notOps },
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

/**
 * Checks a `ctx.approval` request as a workflow may give it, so the UI and the ledger get what
 * the types say, and turns `covers` into op ids.
 */
export const ApprovalRequestSchema = z.object(
  {
    approver: Approver,
    covers: Covers,
    links: z.array(z.string(), { error: "links must be a list of strings" }).optional(),
    details: z.string({ error: "details must be a string" }).optional(),
  },
  { error: "needs a request: { approver, covers?, links?, details? }" },
);

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
   * and messages that were not a decision. `by` is the sender, when the message named one, and
   * `id` the decision message's own, when it had one.
   */
  refused: { by?: string; id?: string; at: number; reason: string }[];
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

/** Checks a `ctx.sleep` request that names a time. */
export const SleepUntil = z.strictObject({
  until: z.union([z.iso.datetime({ offset: true, error: time }), z.number({ error: time })], { error: time }),
}) satisfies z.ZodType<SleepRequest>;

/** Checks a `ctx.sleep` request that names a duration. */
export const SleepFor = z.strictObject({
  ms: duration,
  seconds: duration,
  minutes: duration,
  hours: duration,
  days: duration,
}) satisfies z.ZodType<SleepRequest>;

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

/**
 * A schema as JSON Schema (draft 2020-12). By default it describes what a caller sends
 * (`io: "input"`: defaults stay optional); `io: "output"` describes what parsing returns.
 * What JSON Schema can't express is left open. Throws when zod can't convert the schema at all.
 */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "any" });
}

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
