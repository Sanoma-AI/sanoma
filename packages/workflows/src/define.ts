import type { ConnectionRef } from "./connection.ts";
import type { WorkflowEntry } from "./description.ts";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";
import { z } from "zod";
import { isOp, type Op } from "./op.ts";
import { appOfFile } from "./paths.ts";
import { type DATA_VENDOR, qualified } from "./shared.ts";

/**
 * Who is acting: the person or agent that starts a run, calls an operation or decides an
 * approval. With people declared (`sanoma.person`, `sanoma.agent`, `sanoma.group` in data files),
 * a principal is a declared one, its `groups` every group that lists it; an agent is in the group
 * `agents`, and `onBehalfOf` names the person it acts for.
 */
export interface Principal {
  id: string;
  groups?: string[];
  /** For an agent: the id of the person whose instruction it carries. */
  onBehalfOf?: string;
}

export const Principal: z.ZodType<Principal> = z.object({
  id: z.string().regex(/\S/, "id must not be blank"),
  groups: z.array(z.string()).optional(),
  onBehalfOf: z.string().regex(/\S/, "onBehalfOf must not be blank").optional(),
});

/** A built-in a workflow may call, as its description lists them. */
export type Builtin = WorkflowEntry["builtins"][number];
export type Use = Op | Builtin;

/** Who may decide an approval: one person, by `Principal.id`, or anyone in a group, by `Principal.groups`. */
export type Approver = string | { group: string };

export const Approver: z.ZodType<Approver> = z.union(
  [z.string().regex(/\S/), z.object({ group: z.string().regex(/\S/) })],
  { error: 'needs an approver: a name, or { group: "name" }' },
);

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
  /** Connection binding revision approved by this policy hold. */
  connection?: string;
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
  /** For a policy request: the ledger `seq` of the call held, which its `op.called` record has. */
  opSeq?: number;
  /** For a policy request: the held call's input. */
  input?: unknown;
  /** For a policy request: the policies that held the call, by id, when the policy names them. */
  reasons?: string[];
  /**
   * `withdrawn`: it no longer stands, as when its change got a new commit. A pending approval is
   * withdrawn by a message (`SanomaClient.withdraw`), an approved one by its run
   * (`withdrawApprovals`); either way it lets nothing through and takes no decision.
   */
  status: "pending" | "approved" | "rejected" | "withdrawn";
  /** Why it was withdrawn, once it is. */
  withdrawnReason?: string;
  /** When it was withdrawn, once it is. */
  withdrawnAt?: number;
  /** Who withdrew it, when someone did rather than its run (`withdrawApprovals`). */
  withdrawnBy?: string;
  requestedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /** The `id` of the decision or withdrawal message the run decided with, when it had one. */
  decidedWith?: string;
  /** Set when the run's own actor decided it: nobody else could (`mayDecide`). */
  alone?: true;
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

/** Checks a `ctx.all` argument: a list of functions, each one member. */
export const AllMembers = z.array(
  z.custom<() => unknown>((m) => typeof m === "function", "each member must be a function, such as () => ctx.…"),
  { error: "needs a list of functions: ctx.all([() => …, () => …])" },
);

/**
 * What a step is called, beside its operation: `ctx.ghost.post.create(input, { name: "Draft" })`,
 * `ctx.sleep({ days: 1 }, { name: "Wait a day" })`. A string literal, or a top-level `const` of
 * the workflow's file holding one, so the outline reads it. Without one, a call is named by its
 * operation's id, a sleep `Sleep`; an approval by its title. Names are unique in a workflow, so a
 * workflow that calls one operation twice names the calls.
 */
export interface StepOptions {
  name?: string;
}

type OpsOf<U extends readonly Use[]> = Extract<U[number], Op>;

type VendorCtx<O extends Op, V> = {
  readonly [R in Extract<O, { vendor: V }>["resource"]]: {
    readonly [N in Extract<O, { vendor: V; resource: R }>["name"]]: Extract<
      O,
      { vendor: V; resource: R; name: N }
    > extends Op<any, any, any, infer I, infer Out>
      ? (input: I, options?: StepOptions & { connection?: ConnectionRef<Extract<V, string>> }) => Promise<Out>
      : never;
  };
};

/**
 * `ctx.<vendor>.<resource>.<op>`. An app's collections are `ctx.data.<app>.<name>` at run time,
 * a folder's name no type knows: that level is untyped (`any`), the root's collections typed.
 */
type CtxOps<O extends Op> = {
  readonly [V in O["vendor"]]: V extends typeof DATA_VENDOR
    ? VendorCtx<O, V> & { readonly [app: string]: any }
    : VendorCtx<O, V>;
};

interface ApprovalCtx {
  /** Waits, durably, until the approver (or someone in the approver group) approves. Throws `RejectedError` on a rejection, `WithdrawnError` on a withdrawal. */
  approval(title: string, request: ApprovalRequest): Promise<ApprovalResult>;
}

interface SleepCtx {
  /** Waits, durably, until a time or for a duration. Survives worker restarts. */
  sleep(request: SleepRequest, options?: StepOptions): Promise<void>;
}

interface AllCtx {
  /**
   * Runs the members one after another, in order, and returns their outputs in that order. It
   * declares a fan-out for the ledger and the graph; it adds no concurrency. The first member
   * that throws stops the group with its error, and later members never run. Not nestable.
   */
  all<const T extends readonly (() => Promise<unknown>)[]>(
    members: T,
  ): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

interface BaseCtx {
  /**
   * The current time in epoch milliseconds, recorded so replays see the same value. Use instead
   * of `Date.now()`, which the lint refuses; a date is `new Date(await ctx.now()).toISOString()`.
   */
  now(): Promise<number>;
  readonly runId: string;
}

export type Ctx<U extends readonly Use[]> = BaseCtx &
  CtxOps<OpsOf<U>> &
  ("approval" extends U[number] ? ApprovalCtx : unknown) &
  ("sleep" extends U[number] ? SleepCtx : unknown) &
  ("all" extends U[number] ? AllCtx : unknown);

/**
 * A schema as JSON Schema (draft 2020-12). By default it describes what a caller sends
 * (`io: "input"`: defaults stay optional); `io: "output"` describes what parsing returns.
 * What JSON Schema can't express is left open. Throws when zod can't convert the schema at all.
 */
export function jsonSchemaOf(
  schema: z.ZodType,
  io: "input" | "output" = "input",
  refs?: ReadonlyMap<unknown, string>,
): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    unrepresentable: "any",
    // A schema `refs` names, inside another, becomes a `$ref` to it (a resource type's state).
    ...(refs?.size && {
      override: ({ zodSchema, jsonSchema, path }) => {
        const ref = path.length > 0 ? refs.get(zodSchema) : undefined;
        if (ref === undefined) return;
        for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Record<string, unknown>)[key];
        Object.assign(jsonSchema, { $ref: ref });
      },
    }),
  });
}

/**
 * How a workflow starts: `manual` (by hand, or from code), or on a schedule, `schedule` a cron
 * expression of five fields (minute, hour, day of month, month, day of week) read in `timezone`,
 * an IANA time zone (`Europe/Amsterdam`), UTC without one. A scheduled run is started by the
 * runtime's `schedule` agent with the input `{}`, as the policy allows; it can still be started by hand.
 */
export type Trigger = "manual" | { readonly schedule: string; readonly timezone?: string };

export interface WorkflowDefinition<U extends readonly Use[] = readonly Use[], S extends z.ZodType = z.ZodType> {
  readonly kind: "workflow";
  /** Its name, as written at the root; in an app's folder, `<app>.<name>` (`app`). */
  readonly name: string;
  /** The app whose folder defined it (`apps/<app>/`), from its `file`; absent for one at the root. */
  readonly app?: string;
  readonly title?: string;
  readonly trigger: Trigger;
  readonly input: S;
  /** Every operation and built-in the workflow may call. `ctx` is built from this list and nothing else. */
  readonly uses: U;
  readonly run: (ctx: Ctx<U>, input: z.output<S>) => Promise<unknown>;
  /**
   * The file that defined it, absolute. Set by defineWorkflow from its call site: the outline is
   * read from it, the worker holds each run to that outline, and the app shows it as the code view.
   */
  readonly file: string;
}

/** The ids of the operations a workflow `uses`, in the order declared. */
export const opIdsOf = (wf: Pick<WorkflowDefinition, "uses">): string[] => wf.uses.filter(isOp).map((op) => op.id);

/**
 * Defines a workflow in its own file. Its `name` is a lowercase letter, then lowercase letters,
 * digits and dashes; in an app's folder (`apps/<app>/`, `appOfFile`) the runtime names it
 * `<app>.<name>`, so two apps may each have a `sync`.
 */
export function defineWorkflow<const U extends readonly Use[], S extends z.ZodType>(
  def: Omit<WorkflowDefinition<U, S>, "kind" | "file" | "app">,
): WorkflowDefinition<U, S> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`Workflow name "${def.name}" must be lowercase letters, digits and dashes`);
  }
  checkTrigger(def.name, def.trigger);
  // A scheduled run starts with no input of its own.
  if (def.trigger !== "manual" && !acceptsEmpty(def.input)) {
    throw new Error(
      `Workflow "${def.name}": a scheduled run starts with the input {}, which its input schema refuses: make each field optional or give it a default`,
    );
  }
  const file = callerFile();
  if (file === undefined) {
    throw new Error(
      `Workflow "${def.name}" was defined from code with no file (an eval, or a bundle without one): ` +
        "its outline is read from the file, and a run is held to the outline",
    );
  }
  const app = appOfFile(file);
  return Object.freeze({ kind: "workflow", ...def, name: qualified(app, def.name), ...(app && { app }), file });
}

/** True when `{}` parses: a schema zod can check only asynchronously is taken as accepting it, and the run parses it. */
function acceptsEmpty(schema: z.ZodType): boolean {
  try {
    return schema.safeParse({}).success;
  } catch {
    return true;
  }
}

/** Throws what is wrong with a workflow's `trigger`: not `manual` or a schedule, five fields, in a time zone there is. */
function checkTrigger(name: string, trigger: unknown): void {
  if (trigger === "manual") return;
  const { schedule, timezone } = (typeof trigger === "object" && trigger !== null ? trigger : {}) as {
    schedule?: unknown;
    timezone?: unknown;
  };
  if (typeof schedule !== "string") {
    throw new Error(`Workflow "${name}": its trigger is "manual" or { schedule, timezone? }`);
  }
  if (schedule.trim().split(/\s+/).length !== 5) {
    throw new Error(
      `Workflow "${name}": its schedule "${schedule}" is a cron expression of five fields: minute, hour, day of month, month, day of week`,
    );
  }
  if (timezone !== undefined && !isTimeZone(timezone)) {
    throw new Error(
      `Workflow "${name}": its timezone "${String(timezone)}" is no IANA time zone, such as "Europe/Amsterdam"`,
    );
  }
}

const isTimeZone = (zone: unknown): boolean => {
  // An offset (`+05:30`), which Intl takes too, is no IANA zone name.
  if (typeof zone !== "string" || /^[+-]/.test(zone)) return false;
  try {
    return Boolean(new Intl.DateTimeFormat("en", { timeZone: zone }));
  } catch {
    return false;
  }
};

/**
 * The file of the code that called the function calling this one (`defineWorkflow`'s caller),
 * from V8's call sites, as a path; undefined where there is none.
 */
export function callerFile(): string | undefined {
  // Frame 0 is this function, frame 1 its caller, frame 2 theirs: by index, since a bundle may hold all three.
  return scriptPath(getCallSites(3)[2]?.scriptName);
}

/** A V8 script name (a `file:` URL for a module, a path for a script) as a path; undefined for none. */
export function scriptPath(script: string | undefined): string | undefined {
  if (!script?.startsWith("file:")) return script || undefined;
  try {
    return fileURLToPath(script);
  } catch {
    return undefined;
  }
}
