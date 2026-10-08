import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { awaitApproval, type CheckedApproval } from "./approvals.ts";
import {
  ApprovalExtras,
  type ApprovalRequest,
  Approver,
  approverLabel,
  Covers,
  SleepFor,
  type SleepRequest,
  SleepUntil,
  type Use,
  type WorkflowDefinition,
} from "./define.ts";
import {
  errorCode,
  errorInfo,
  errorMessage,
  isFinal,
  keepCode,
  parseOrThrow,
  PolicyDeniedError,
  SanomaError,
} from "./errors.ts";
import { entry, skipped, write, writeFailure } from "./ledger.ts";
import { type CallContext, isOp, type Op } from "./op.ts";
import { DecisionSchema, type PolicyCall, policyOpOf, type RecordedDecision } from "./policy.ts";
import type { Run } from "./run.ts";

// What DBOS throws into a run whose worker is shutting down. Verified for DBOS 5.2: a
// pending recv rejects with DBOSError("The system database has been shut down"). They are
// DBOS's own errors but not of a class of their own, so they are matched by message, and only
// on an error DBOS made: a vendor's message may say anything. A sleep or step that finishes
// after shutdown fails with pg's "Cannot use a pool after calling end on the pool", a plain
// error, which the worker's `stopped` flag covers instead.
const SHUTDOWN = /system database has been shut down|System database shutting down/;

const fromDbos = (e: Error) => e.name.startsWith("DBOS") || (e.constructor?.name ?? "").startsWith("DBOS");

/**
 * True for errors that come from DBOS itself rather than the run: cancellation, lost ownership,
 * or shutdown, which includes anything that fails once the run's worker has stopped. Such a
 * failure is not the run's outcome, so the ledger does not record it.
 */
export function isInfrastructureError(err: unknown, run?: Pick<Run, "state">): boolean {
  if (run?.state.stopped) return true;
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof DBOSErrors.DBOSWorkflowCancelledError || e instanceof DBOSWorkflowConflictError) return true;
    if (fromDbos(e) && SHUTDOWN.test(e.message)) return true;
  }
  return false;
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

/** The run's `ctx`: the operations and built-ins its workflow `uses`, and nothing else. */
export function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  const uses = wf.uses as readonly Use[];
  const members: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (members[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = (input: unknown) => callOp(run, op.id, input);
  }
  members.runId = run.id;
  members.now = () => DBOS.now();
  if (uses.includes("approval")) {
    members.approval = (title: string, req: ApprovalRequest) => awaitApproval(run, title, checkApproval(title, req));
  }
  if (uses.includes("sleep")) members.sleep = (req: unknown) => sleep(req);

  // Every function goes through the run's queue, so no member can be added that skips it.
  const queued = (node: Record<string, unknown>, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "function") out[key] = (...args: unknown[]) => serial(run, () => value(...args));
      else if (typeof value === "object" && value !== null) {
        out[key] = queued(value as Record<string, unknown>, `${path}.${key}`);
      } else out[key] = value;
    }
    return strict(out, path, wf.name);
  };
  return queued(members, "ctx");
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

/** A value as JSON, for a message, or as a string when it isn't JSON. */
function shown(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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
    if (isInfrastructureError(err, run)) throw err;
    throw keepCode(new Error(`The policy failed deciding ${op.id}: ${errorMessage(err)}`, { cause: err }), err);
  }
  const decision = checkDecision(answer, op.id);
  const policyVersion = run.state.policy.version;
  return policyVersion === undefined ? decision : { ...decision, policyVersion };
}

async function callOp(run: Run, id: string, input: unknown) {
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
  const call = { type: "op.called", op: op.id, effect: op.effect, input: parsed, decision } as const;

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
      await awaitApproval(run, title, { approver: decision.approver, covers }, { op: op.id, input: parsed });
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
    if (isInfrastructureError(err, run)) skipped(record, `the call was interrupted by DBOS (${errorMessage(err)})`);
    else await writeFailure(run, record, err);
    throw err;
  }
  const { output, at, durationMs } = result;
  await write(run, entry(run, { ...call, output, durationMs, attempt: result.attempt }, { seq, at }));
  return output;
}

/**
 * Checks a `ctx.approval` request before any DBOS call, so a bad one fails the run with
 * `invalid_input`: who may decide it, and the operations it covers, as ids (none unless named).
 */
function checkApproval(title: string, req: ApprovalRequest): CheckedApproval {
  const approver = parseOrThrow(Approver, req?.approver, `ctx.approval("${title}")`, { title });
  const covers = parseOrThrow(Covers, req.covers, `ctx.approval("${title}") covers`, { title });
  const { links, details } = parseOrThrow(
    ApprovalExtras,
    { links: req.links, details: req.details },
    `ctx.approval("${title}")`,
    { title },
  );
  return { approver, covers: covers ?? [], links, details };
}

/** Checks a sleep request before any DBOS call, so a bad one fails the run with `invalid_input`. */
function checkSleep(req: unknown): SleepRequest {
  const timed = typeof req === "object" && req !== null && "until" in req;
  return parseOrThrow(timed ? SleepUntil : SleepFor, req, `ctx.sleep(${shown(req)})`);
}

/** Waits, durably, until the time or for the duration the request names. */
async function sleep(raw: unknown) {
  const req = checkSleep(raw);
  let ms: number;
  if ("until" in req) {
    const target = typeof req.until === "number" ? req.until : Date.parse(req.until);
    ms = target - (await DBOS.now());
  } else {
    ms =
      (req.ms ?? 0) +
      (req.seconds ?? 0) * 1_000 +
      (req.minutes ?? 0) * 60_000 +
      (req.hours ?? 0) * 3_600_000 +
      (req.days ?? 0) * 86_400_000;
  }
  // A time already past waits not at all, and adds no step.
  if (ms > 0) await DBOS.sleep(ms);
}
