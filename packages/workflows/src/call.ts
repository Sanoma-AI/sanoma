import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { awaitApproval, type CheckedApproval } from "./approvals.ts";
import { offsetOf } from "./ast.ts";
import {
  AllMembers,
  type ApprovalRequest,
  ApprovalRequestSchema,
  SleepFor,
  type SleepRequest,
  SleepUntil,
  scriptPath,
  type Use,
  type WorkflowDefinition,
} from "./define.ts";
import { errorCode, errorInfo, isFinal, keepCode, parseOrThrow, PolicyDeniedError, SanomaError } from "./errors.ts";
import { currentGroup, entry, skipped, write, writeFailure } from "./ledger.ts";
import { shown } from "./log.ts";
import { type CallContext, isOp, type Op } from "./op.ts";
import { callAt, callName, type CallNode } from "./outline.ts";
import { DecisionSchema, type PolicyCall, policyOpOf, type RecordedDecision } from "./policy.ts";
import type { Run, WorkerState } from "./run.ts";
import { approverLabel, errorMessage, fitsOp } from "./shared.ts";

/** The error and the ones it was caused by, a few deep. */
function causes(err: unknown): Error[] {
  const out: Error[] = [];
  for (let e = err; e instanceof Error && out.length < 5; e = e.cause) out.push(e);
  return out;
}

/** DBOS took the run from this execution: it cancelled the run, or another process took it over. */
const takenByDbos = (err: unknown) =>
  causes(err).some((e) => e instanceof DBOSErrors.DBOSWorkflowCancelledError || e instanceof DBOSWorkflowConflictError);

/**
 * True for a failure that ends the run rather than one call: anything DBOS throws (it cancelled
 * the run, another process took it over, the worker is shutting down, the run is not
 * deterministic) and `run_ended` (a call queued after the run's body ended). Looked for in the
 * error and its causes. A workflow that goes on past a failed call, as `drift` does, rethrows these.
 */
export const isRunControlError = (err: unknown): boolean =>
  causes(err).some((e) => e instanceof DBOSErrors.DBOSError || errorCode(e) === "run_ended");

/**
 * True for a failure that is not the run's outcome, so the ledger does not record it: DBOS
 * cancelled the run or another process took it over, or the run's worker is stopping and the
 * error has none of our codes. `stop()` marks the worker stopped before DBOS shuts down, so from
 * then on whatever fails without a code (DBOS's "system database has been shut down", pg's
 * closed pool) is the shutdown, and the run recovered on the next worker records how it ends.
 * A coded failure then (a driver's final answer, a denial, a rejection) is still the outcome:
 * DBOS records the run's error and never runs it again, so the ledger records it too. Narrower
 * than `isRunControlError`: DBOS's other errors (a run that is not deterministic) end the run
 * for good, and are recorded.
 */
export function isInfrastructureError(err: unknown, state: Pick<WorkerState, "stopped">): boolean {
  return takenByDbos(err) || (state.stopped && errorCode(err) === undefined);
}

/** The value as the ledger records it: each of the operation's `opaque` fields as `"<name>"`. */
function recorded(op: Op, value: unknown): unknown {
  if (!op.opaque?.length || typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const name of op.opaque) if (out[name] !== undefined) out[name] = `<${name}>`;
  return out;
}

/** How many times an idempotent operation is tried. */
const MAX_ATTEMPTS = 3;

// Matched by name too, since a workflow's schemas may come from another copy of zod.
const isSchemaError = (err: unknown) => err instanceof Error && err.name === "ZodError";

/**
 * Whether DBOS should try an idempotent step again: not when the reply failed the output
 * schema (it would fail again), and not when the driver said the vendor's answer is final
 * (a `DriverError` with `retryable: false`, such as a 4xx). Read by code and property, never
 * `instanceof`: the error may come from another copy of this package.
 */
function shouldRetry(err: unknown): boolean {
  if (isSchemaError(err)) return false;
  return !(errorCode(err) === "driver_failed" && isFinal(err));
}

/*
 * A run's ctx calls run one at a time, in program order, even when the workflow starts several
 * at once (Promise.all). Every DBOS call (a step, now, sleep, setEvent, recv) takes the run's
 * next function id when it starts, and a replay matches each recorded result to a call by that
 * id. Calls left to run concurrently would take ids in the order their earlier awaits happened
 * to resolve, which differs between the first execution and a replay that reads results back
 * from the database, and so would the ledger's `seq` and the approval ids. Queued, each call
 * starts once the one before it has settled, so the order is the order the workflow made them.
 */
function serial<T>(run: Run, call: () => Promise<T>): Promise<T> {
  // A failure rejects its caller; the calls queued after it still run, since the workflow may
  // have caught it. Once the workflow body itself has ended, nothing queued may run. The body
  // awaits only ctx calls, so one macrotask after the call before settles, the body has either
  // caught the failure and gone on or ended; the rejection alone reaches it in the same
  // microtask flush that would start this call.
  const next = run.tail
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      refuseIfEnded(run);
      return call();
    });
  // Settled either way, and holding nothing: the queue keeps neither the output nor the error.
  run.tail = next.then(noop, noop);
  return next;
}

const noop = () => {};

/** Throws once the workflow body has returned or thrown: a call left queued must not run then. */
function refuseIfEnded(run: Run) {
  if (run.ended) {
    throw new SanomaError("run_ended", `run ${run.id} has ended; a call queued behind its failure was not made`, {
      runId: run.id,
    });
  }
}

/**
 * The run's `ctx`: the operations and built-ins its workflow `uses`, and nothing else. Every
 * member that writes a record is placed in the outline where the workflow calls it (`placeCall`)
 * and goes through the run's queue (`serial`); `ctx.now()` only reads the clock, queued, and
 * `ctx.runId` is a value. `ctx.all` alone skips the queue: it makes no DBOS call or record
 * itself, it only calls its members, whose ctx calls are queued. Queued, it would hold the queue
 * until its members settled, and their calls, queued behind it, would never start.
 */
export function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  const uses = wf.uses as readonly Use[];
  /** A member placed where it is called, then `call`ed with its node. A refusal rejects, as a member's failure always has. */
  const placed = (what: string, call: (node: string, ...args: any[]) => Promise<unknown>) =>
    async function member(...args: unknown[]) {
      const at = placeCall(run, member, what);
      return call(at.path, ...args);
    };
  const members: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (members[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = placed(op.id, (node, input) => serial(run, () => callOp(run, op.id, input, node)));
  }
  members.runId = run.id;
  members.now = () => serial(run, () => DBOS.now());
  if (uses.includes("approval")) {
    members.approval = placed("approval", (node, title: string, req: ApprovalRequest) =>
      serial(run, () => awaitApproval(run, title, checkApproval(title, req), node)),
    );
  }
  if (uses.includes("sleep")) members.sleep = placed("sleep", (node, req) => serial(run, () => sleep(run, req, node)));
  if (uses.includes("all")) members.all = placed("all", (node, list) => all(run, list, node));
  return guarded(members, "ctx", wf.name);
}

/** `members`, each object in it included, refusing any member not in it (`strict`). */
function guarded(members: Record<string, unknown>, path: string, workflow: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(members)) {
    out[key] =
      typeof value === "object" && value !== null
        ? guarded(value as Record<string, unknown>, `${path}.${key}`, workflow)
        : value;
  }
  return strict(out, path, workflow);
}

/** Where a `ctx` member was called from, as a stack frame says. */
interface CallSite {
  file: string;
  line: number;
  column: number;
}

/**
 * The frame above `fn`, the `ctx` member running, read from a stack trace rather than
 * `util.getCallSites`: a test runner that transforms the source maps the trace back to it, and
 * Node runs TypeScript stripped in place, so the position is the file's either way. One frame is
 * captured: the rest would only be formatted and dropped.
 */
function callSite(fn: Function): CallSite | undefined {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  try {
    Error.captureStackTrace(holder, fn);
  } finally {
    Error.stackTraceLimit = limit;
  }
  // `at run (/dir/file.ts:21:37)`, `at /dir/file.ts:21:37` or `at async run (file:///dir/file.ts:21:37)`.
  const frame = holder.stack?.split("\n")[1]?.trim();
  const m = frame === undefined ? null : /^at (?:.*?\()?(.+?):(\d+):(\d+)\)?$/.exec(frame);
  const file = m && scriptPath(m[1]);
  return file ? { file, line: Number(m[2]), column: Number(m[3]) } : undefined;
}

/**
 * The outline node the workflow calls a `ctx` member at: the call whose code holds the position
 * the workflow called from (`callSite`). `what` is the member's path on `ctx` (`ghost.post.create`,
 * `approval`, `all`). The outline refuses most ways around it before a run (`outlineBody`'s
 * problems); this is the run's own check, for what reaches a `ctx` member from code the outline
 * has no node for: another file, a function defined inside `run` the outline does not read,
 * `arguments`, or a node of another kind. The run fails with `call_not_in_outline`, and every
 * record the call writes names the node, so a run's steps are the outline's calls and nothing else.
 */
function placeCall(run: Run, fn: Function, what: string): CallNode {
  const { outline, workflow } = run;
  const site = callSite(fn);
  if (!site) throw notInOutline(run, what, site, "which the outline cannot place");
  if (site.file !== outline.file)
    throw notInOutline(run, what, site, `which is not in ${workflow}'s file ${outline.file}`);
  const offset = offsetOf(outline.lineStarts, site.line, site.column);
  const node = offset === undefined ? undefined : callAt(outline.calls, offset);
  if (!node) throw notInOutline(run, what, site, `which is no ctx call in ${workflow}'s outline`);
  // The member called is the node's call: `ctx.all` at an `all` or `each`, an operation at its op.
  if (!fitsOp(callName(node), what)) throw notInOutline(run, what, site, `where the outline has ctx.${callName(node)}`);
  return node;
}

function notInOutline(run: Run, what: string, site: CallSite | undefined, why: string): SanomaError {
  const where = site ? `${site.file}:${site.line}:${site.column}` : "a place the stack does not show";
  return new SanomaError(
    "call_not_in_outline",
    `ctx.${what} was called from ${where}, ${why}: call ctx directly in run, not from a helper or a function ` +
      "defined inside run (inline it), so the run's graph shows the call",
    { call: `ctx.${what}`, site: where, workflow: run.workflow },
  );
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

/** Checks a policy's answer, and copies it so nothing else the policy returned is recorded. */
function checkDecision(decision: unknown, opId: string): RecordedDecision {
  const parsed = DecisionSchema.safeParse(decision);
  if (parsed.success) return parsed.data;
  const why = parsed.error.issues[0]?.message ?? "not a decision";
  throw new Error(
    `The policy returned ${shown(decision)} for ${opId}: ${why}; use allow(), deny(reason) or approve(approver)`,
  );
}

/** The resource instance the call acts on, from the operation's `target`, when it declares one. */
function targetOf(op: Op, input: unknown): { target?: string } {
  if (!op.target) return {};
  const target: unknown = op.target(input);
  if (typeof target !== "string") {
    throw new Error(`${op.id}: \`target\` returned ${typeof target}, not a string`);
  }
  return { target };
}

/** Asks the policy. Runs inside a step, so it must have no side effects of its own. */
async function decide(run: Run, op: Op, input: unknown): Promise<RecordedDecision> {
  const call: PolicyCall = {
    op: policyOpOf(op),
    effect: op.effect,
    ...targetOf(op, input),
    input,
    actor: run.actor,
    run: { id: run.id, workflow: run.workflow, approvals: structuredClone(run.approvals) },
  };
  let answer: unknown;
  try {
    answer = await run.state.policy(call);
  } catch (err) {
    // Named here, so the run's error and the ledger say which call the policy failed on, with
    // the code the policy's error had.
    if (isInfrastructureError(err, run.state)) throw err;
    throw keepCode(new Error(`The policy failed deciding ${op.id}: ${errorMessage(err)}`, { cause: err }), err);
  }
  const decision = checkDecision(answer, op.id);
  const policyVersion = run.state.policy.version;
  return policyVersion === undefined ? decision : { ...decision, policyVersion };
}

async function callOp(run: Run, id: string, input: unknown, node: string) {
  // The worker's declaration, never the workflow's: its effect, schemas and retry setting.
  const op = run.state.ops.get(id);
  const fn = run.state.drivers.get(id);
  if (!op || !fn) throw new Error(`No connector or driver for ${id} in this worker`);
  const parsed = parseOrThrow(op.input, input, `The input to ${op.id} does not match its schema`, { op: op.id });
  // The call's identity (its ledger seq and id, and the driver's idempotency key) is taken
  // before the first await, so it depends only on the order the workflow made its calls. A
  // replay skips the step bodies but counts the same way. A call held for an approval is
  // numbered before the approval's records, so its op.called sorts ahead of them.
  const seq = run.seq++;
  // The decision is recorded as a step, so a replay reuses it instead of asking a policy
  // that may have changed since. The policy must still be deterministic: a run that fails
  // before the step is recorded asks again.
  const decision = await DBOS.runStep(() => decide(run, op, parsed), { name: `policy:${op.id}` });
  const logged = recorded(op, parsed);
  const call = { type: "op.called", op: op.id, node, effect: op.effect, input: logged, decision } as const;

  if (decision.kind === "deny") {
    const err = new PolicyDeniedError(op.id, decision.reason);
    await writeFailure(run, entry(run, { ...call, error: errorInfo(err), durationMs: 0 }, { seq }), err);
    throw err;
  }
  if (decision.kind === "approve") {
    const title = decision.title ?? `${op.id} needs ${approverLabel(decision.approver)}`;
    // A hold covers the call it held, and any other operations the policy named.
    const covers = [...new Set([op.id, ...(decision.covers ?? [])])];
    try {
      await awaitApproval(run, title, { approver: decision.approver, covers }, node, { op: op.id, seq, input: logged });
    } catch (err) {
      if (errorCode(err) === "approval_rejected") {
        const approval = (err as SanomaError).data.approvalId as string;
        const record = entry(run, { ...call, approval, error: errorInfo(err), durationMs: 0 }, { seq });
        await writeFailure(run, record, err);
      }
      throw err;
    }
  }

  const started = Date.now();
  // The try DBOS is on, as it passes it to the step. The last try's error is not retried, so
  // DBOS records and throws it as the vendor gave it, never wrapped with the others.
  let attempt: number | undefined;
  let result: { output: unknown; at: number; durationMs: number; attempt: number };
  try {
    result = await DBOS.runStep(
      async () => {
        const at = Date.now();
        attempt = DBOS.stepStatus?.currentAttempt ?? 1;
        const context: CallContext = { idempotencyKey: `${run.id}:${seq}`, runId: run.id, opId: op.id, attempt };
        const output = op.output.parse(await fn(parsed, context));
        return { output, at, durationMs: Date.now() - at, attempt };
      },
      {
        name: op.id,
        retriesAllowed: op.idempotent,
        maxAttempts: MAX_ATTEMPTS,
        shouldRetry: (e) => shouldRetry(e) && (attempt ?? 1) < MAX_ATTEMPTS,
      },
    );
  } catch (err) {
    // The step failed for good; on replay DBOS rethrows the recorded error, and this record
    // gets the same id. A success record would too, so a call has one op.called at most.
    const record = entry(
      run,
      { ...call, error: errorInfo(err), durationMs: Date.now() - started, ...(attempt ? { attempt } : {}) },
      { seq, at: started },
    );
    if (isInfrastructureError(err, run.state)) skipped(record, `the call was interrupted (${errorMessage(err)})`);
    else await writeFailure(run, record, err);
    throw err;
  }
  const { output, at, durationMs } = result;
  try {
    await write(
      run,
      entry(run, { ...call, output: recorded(op, output), durationMs, attempt: result.attempt }, { seq, at }),
    );
  } catch (err) {
    // The vendor acted, and nothing records it. A workflow that caught this and called again
    // would repeat the side effect under a new key, so the run makes no further calls.
    run.ended = true;
    throw new Error(`${op.id} succeeded, but the ledger could not record it: ${errorMessage(err)}`, { cause: err });
  }
  return output;
}

/**
 * Checks a `ctx.approval` request before any DBOS call, so a bad one fails the run with
 * `invalid_input`: who may decide it, and the operations it covers, as ids (none unless named).
 */
function checkApproval(title: string, req: ApprovalRequest): CheckedApproval {
  const checked = parseOrThrow(ApprovalRequestSchema, req, `ctx.approval("${title}")`, { title });
  return { ...checked, covers: checked.covers ?? [] };
}

/** Checks a sleep request before any DBOS call, so a bad one fails the run with `invalid_input`. */
function checkSleep(req: unknown): SleepRequest {
  const timed = typeof req === "object" && req !== null && "until" in req;
  return parseOrThrow(timed ? SleepUntil : SleepFor, req, `ctx.sleep(${shown(req)})`);
}

/**
 * Calls the members one after another, each awaited before the next starts, each inside its
 * group (`currentGroup`), so every record its calls write carries it. The first failure stops
 * the group and is rethrown as it is. The id is the run's next `seq` when ctx.all begins, which
 * depends only on the calls made before it, so a replay names the group the same.
 */
async function all(run: Run, list: unknown, node: string): Promise<unknown[]> {
  const outer = currentGroup.getStore();
  if (outer) {
    throw new SanomaError("invalid_input", "ctx.all cannot be nested: a member of a ctx.all called ctx.all", {
      group: outer.id,
    });
  }
  // Two groups' calls would interleave on the run's queue, and neither would read as one fan-out.
  if (run.inAll) throw new SanomaError("invalid_input", "a ctx.all is already running: await it before the next");
  const members = parseOrThrow(AllMembers, list, "ctx.all");
  const id = `all:${run.seq}`;
  const outputs: unknown[] = [];
  run.inAll = true;
  try {
    for (const [index, member] of members.entries()) {
      outputs.push(await currentGroup.run({ id, index, size: members.length, node }, member));
    }
  } finally {
    run.inAll = false;
  }
  return outputs;
}

/**
 * Waits, durably, until the time or for the duration the request names, and records when it
 * ends. For a duration that is the time the sleep started plus the duration, as the runtime saw
 * it (`Date.now()`, which adds no DBOS call): a replay may compute another, but the store keeps
 * the first record with the id, so the record says what the first execution waited for.
 */
async function sleep(run: Run, raw: unknown, node: string) {
  const req = checkSleep(raw);
  const seq = run.seq++;
  let until: number;
  let ms: number;
  if ("until" in req) {
    until = typeof req.until === "number" ? req.until : Date.parse(req.until);
    ms = until - (await DBOS.now());
  } else {
    ms =
      (req.ms ?? 0) +
      (req.seconds ?? 0) * 1_000 +
      (req.minutes ?? 0) * 60_000 +
      (req.hours ?? 0) * 3_600_000 +
      (req.days ?? 0) * 86_400_000;
    until = Date.now() + ms;
  }
  await write(run, entry(run, { type: "sleep.started", node, until }, { seq }));
  // A time already past waits not at all, and adds no step.
  if (ms > 0) await DBOS.sleep(ms);
}
