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

export interface ApprovalRequest {
  /** Who must approve, by name. Phase 4 replaces this with a Cedar decision. */
  approver: string;
  links?: string[];
  details?: string;
}

/** One approval in a run, as the run sees it. Published as the run's "approvals" event. */
export interface ApprovalState extends ApprovalRequest {
  id: string;
  title: string;
  /** Who asked: the workflow (`ctx.approval`), or the policy holding an operation call. */
  requestedBy: "workflow" | "policy";
  /** For a policy request: the operation call held, by op id. */
  op?: string;
  /** For a policy request: the held call's input. */
  input?: unknown;
  status: "pending" | "approved" | "rejected";
  requestedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /**
   * Messages that were ignored: decisions sent by someone other than the named approver,
   * and messages that were not a decision. `by` is the sender, when the message named one.
   */
  refused: { by?: string; at: number; reason: string }[];
}

export interface ApprovalResult {
  approvedBy: string;
  at: number;
  note?: string;
}

export type SleepRequest =
  | { until: string | number }
  | { ms?: number; seconds?: number; minutes?: number; hours?: number; days?: number };

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
  /** Waits, durably, until the named approver approves. Throws `RejectedError` if they reject. */
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
