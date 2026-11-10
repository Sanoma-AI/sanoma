import type { CheckedApproval } from "./approvals.ts";
import type { ConnectionRef } from "./connection.ts";
import {
  type ApprovalRequest,
  ApprovalRequestSchema,
  type ApprovalResult,
  type Principal,
  SleepFor,
  type SleepRequest,
  SleepUntil,
  type StartedBy,
  type StepOptions,
  type Use,
  type WorkflowDefinition,
} from "./define.ts";
import { parseOrThrow } from "./errors.ts";
import { isOp, type Op } from "./op.ts";
import type { CallNode } from "./outline.ts";
import { DEFAULT_SLEEP_NAME, entryOpsOf, isBatch, LOGIN_CODE_WORKFLOW, shown } from "./shared.ts";

// A run's `ctx`, built the same way wherever the run is: on DBOS in a worker (`buildCtx` in
// `call.ts`), and in memory in a page (`page-run.ts`). This module builds the members and names
// each call's step; a `CtxRunner` makes the calls. Browser-safe: no DBOS, no Node.

/**
 * Where a call is, as its records say: its outline node's `path`, none in a page (which reads no
 * outline), and the step's name, as the outline resolved it (`OutlineNode`'s `name`), or for a
 * call the outline could not name, the operation a computed id called, or an approval's title
 * that is no literal.
 */
export interface Placed {
  node?: string;
  name: string;
}

/** How a run's `ctx` members are carried out: what `ctxOf` calls, once it has placed a call. */
export interface CtxRunner {
  /**
   * The outline node `member`, the `ctx` member called as `what` (`ghost.post.create`,
   * `approval`, `all`), was called at; a refusal throws. None where the run reads no outline.
   */
  place(member: Function, what: string): CallNode | undefined;
  op(op: Op, input: unknown, at: Placed, connection?: ConnectionRef): Promise<unknown>;
  /** The run's clock. */
  now(): Promise<number>;
  approval(title: string, request: ApprovalRequest, at: Placed): Promise<ApprovalResult>;
  sleep(request: unknown, at: Placed): Promise<void>;
  all(members: unknown, at: Placed): Promise<unknown[]>;
}

/** The step's name the outline gives a call's node: none for a computed op without one, or an approval's title that is no literal. */
const named = (node: CallNode) => ("name" in node ? node.name : undefined);

/**
 * The run's `ctx`: the operations and built-ins its workflow `uses`, and nothing else. Every
 * member that writes a record is placed where the workflow calls it (`CtxRunner.place`) and
 * named (the outline's name, else `fallback`'s), then made by the runner; `ctx.now()` only reads
 * the run's clock, and `ctx.runId` and `ctx.startedBy` are values.
 */
export function ctxOf(wf: WorkflowDefinition<any, any>, run: { id: string; actor: Principal }, runner: CtxRunner): any {
  const uses = wf.uses as readonly Use[];
  /** A member placed where it is called, then `call`ed there. A refusal rejects, as a member's failure always has. */
  const placed = (
    what: string,
    fallback: (...args: any[]) => string,
    call: (at: Placed, ...args: any[]) => Promise<unknown>,
  ) =>
    async function member(...args: unknown[]) {
      const node = runner.place(member, what);
      const name = (node && named(node)) ?? fallback(...args);
      return call({ ...(node && { node: node.path }), name }, ...args);
    };
  const members: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    // By the id's segments: an app's collection, `data.crm.contacts.get`, is `ctx.data.crm.contacts.get`.
    const group = op.id
      .split(".")
      .slice(0, -1)
      .reduce<Record<string, any>>((at, key) => (at[key] ??= {}), members);
    group[op.name] = placed(
      op.id,
      () => op.id,
      (at, input, options?: { connection?: ConnectionRef }) => runner.op(op, input, at, options?.connection),
    );
  }
  members.runId = run.id;
  members.now = runner.now;
  if (uses.includes("approval")) {
    members.approval = placed(
      "approval",
      (title: string) => title,
      (at, title, req) => runner.approval(title, req, at),
    );
  }
  if (uses.includes("sleep")) {
    // The outline names every sleep; where there is none, the sleep's own name does.
    members.sleep = placed(
      "sleep",
      (_req, options?: StepOptions) => options?.name ?? DEFAULT_SLEEP_NAME,
      (at, req) => runner.sleep(req, at),
    );
  }
  if (uses.includes("all"))
    members.all = placed(
      "all",
      () => "all",
      (at, list) => runner.all(list, at),
    );
  return guarded(members, "ctx", wf.name, { startedBy: startedByOf(run.actor) });
}

/** Who started the run, as `ctx.startedBy` shows it: a plain frozen record, whose absent fields read as undefined. */
const startedByOf = ({ id, email, github, subject }: Principal): StartedBy =>
  Object.freeze({ id, ...(email && { email }), ...(github && { github }), ...(subject && { subject }) });

/** `members`, each object in it included, refusing any member not in it (`strict`), with `plain`'s as they are. */
function guarded(
  members: Record<string, unknown>,
  path: string,
  workflow: string,
  plain: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(members)) {
    out[key] =
      typeof value === "object" && value !== null
        ? guarded(value as Record<string, unknown>, `${path}.${key}`, workflow)
        : value;
  }
  return strict({ ...out, ...plain }, path, workflow);
}

/** Refuses anything not declared in `uses`, with a message that says so. */
function strict<T extends object>(obj: T, path: string, workflow: string): T {
  return new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key in target) return Reflect.get(target, key, receiver);
      throw new Error(`${path}.${key} is not available: add it to \`uses\` in workflow "${workflow}"`);
    },
  });
}

/**
 * Checks a `ctx.approval` request before the runner acts on it, so a bad one fails the run with
 * `invalid_input`: who may decide it, and the operations it covers, as ids (none unless named).
 */
export function checkApproval(title: string, req: ApprovalRequest): CheckedApproval {
  const checked = parseOrThrow(ApprovalRequestSchema, req, `ctx.approval("${title}")`, { title });
  return { ...checked, covers: checked.covers ?? [] };
}

/** Checks a sleep request before the runner acts on it, so a bad one fails the run with `invalid_input`. */
export function checkSleep(req: unknown): SleepRequest {
  const timed = typeof req === "object" && req !== null && "until" in req;
  return parseOrThrow(timed ? SleepUntil : SleepFor, req, `ctx.sleep(${shown(req)})`);
}

/** When a sleep that starts at `started` ends, in ms since the epoch: the time asked for, or `started` plus the duration. */
export const untilOf = (req: SleepRequest, started: number): number =>
  "until" in req
    ? typeof req.until === "number"
      ? req.until
      : Date.parse(req.until)
    : started +
      (req.ms ?? 0) +
      (req.seconds ?? 0) * 1_000 +
      (req.minutes ?? 0) * 60_000 +
      (req.hours ?? 0) * 3_600_000 +
      (req.days ?? 0) * 86_400_000;

/** The fields of a mail a `login-code` run sends that the ledger never shows: its body, which holds the code. */
const LOGIN_CODE_BODY = ["text", "html"];

/**
 * The value as the ledger records it: each of the operation's `opaque` fields as `"<name>"`, and
 * in a run of `workflow` `login-code`, the mail's `text` and `html` too, so no colleague reads another's code.
 */
export function recorded(op: Op, value: unknown, workflow?: string): unknown {
  const hidden = [...(op.opaque ?? []), ...(workflow === LOGIN_CODE_WORKFLOW ? LOGIN_CODE_BODY : [])];
  if (!hidden.length || typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const name of hidden) if (out[name] !== undefined) out[name] = `<${name}>`;
  return out;
}

/** The resource instance the call acts on, from the operation's `target`, when it declares one. */
export function targetOf(op: Op, input: unknown): { target?: string } {
  if (!op.target) return {};
  const target: unknown = op.target(input);
  if (typeof target !== "string") {
    throw new Error(`${op.id}: \`target\` returned ${typeof target}, not a string`);
  }
  return { target };
}

/** One call as the policy decides it and the ledger records it: an operation and its parsed input. */
export interface Call {
  op: Op;
  input: unknown;
}

/**
 * The calls a call makes: a collection's `saveMany` (`isBatch`) makes one per entry, the
 * collection's `save` or `delete` with the entry as its input, and these are what the policy
 * decides and the ledger records, so a record's history reads the same whether it was saved
 * alone or in a batch; any other call makes itself.
 */
export function callsOf(op: Op, input: unknown, ops: ReadonlyMap<string, Op>): Call[] {
  if (!isBatch(op)) return [{ op, input }];
  const { records, deletes } = input as { records: unknown[]; deletes: unknown[] };
  const [save, remove] = entryOpsOf(op).map((id) => ops.get(id)!);
  return [...records.map((e) => ({ op: save!, input: e })), ...deletes.map((e) => ({ op: remove!, input: e }))];
}

/**
 * What a call's `op.called` record says of the call itself, wherever it was made (a worker's run,
 * a direct call, a page's run): its operation, the instance it acted on, its effect and its
 * input as the ledger records it (`recorded`).
 */
export const opCalled = (c: Call, workflow?: string) => ({
  type: "op.called" as const,
  op: c.op.id,
  ...targetOf(c.op, c.input),
  effect: c.op.effect,
  input: recorded(c.op, c.input, workflow),
});

/** The outputs of the calls a call made, from its output: a batch's, one per entry, in order. */
export const outputsOf = (op: Op, output: unknown): unknown[] => (isBatch(op) ? (output as unknown[]) : [output]);
