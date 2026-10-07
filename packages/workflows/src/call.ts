import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { approverLabel, awaitApproval } from "./approvals.ts";
import { type ApprovalRequest, SleepRequest, type Use, type WorkflowDefinition } from "./define.ts";
import { errorCode, errorInfo, errorMessage, PolicyDeniedError, SanomaError } from "./errors.ts";
import { entry, skipped, write, writeFailure } from "./ledger.ts";
import { type CallContext, isOp, type Op } from "./op.ts";
import { Decision, type PolicyCall, type RecordedDecision } from "./policy.ts";
import type { Run } from "./run.ts";

// What DBOS throws into a run whose worker is shutting down. Verified for DBOS 5.2: a
// pending recv rejects with DBOSError("The system database has been shut down"), and a
// sleep or step that finishes after shutdown fails with pg's "Cannot use a pool after
// calling end on the pool". They are plain errors, so they are matched by message.
const SHUTDOWN =
  /system database has been shut down|System database shutting down|Cannot use a pool after calling end on the pool/;

/** True for errors that come from DBOS itself rather than the run: cancellation, lost ownership, shutdown. */
export function isInfrastructureError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof DBOSErrors.DBOSWorkflowCancelledError || e instanceof DBOSWorkflowConflictError) return true;
    if (SHUTDOWN.test(e.message)) return true;
  }
  return false;
}

// Matched by name too, since a workflow's schemas may come from another copy of zod.
const isSchemaError = (err: unknown) => err instanceof Error && err.name === "ZodError";

/**
 * Whether DBOS should try an idempotent step again: not when the reply failed the output
 * schema (it would fail again), and not when the driver said the vendor's answer is final
 * (a `DriverError` with `retryable: false`, such as a 4xx). Read by code and property, never
 * `instanceof`: the error may come from another copy of this package.
 */
export function shouldRetry(err: unknown): boolean {
  if (isSchemaError(err)) return false;
  return !(errorCode(err) === "driver_failed" && (err as { retryable?: unknown }).retryable === false);
}

// DBOS's code for a step that ran out of tries, read from an instance so it is not copied here.
const MAX_RETRIES = new DBOSErrors.DBOSMaxStepRetriesError("", 0, []).dbosErrorCode;

/**
 * The error a step failed with, as the vendor gave it. When an idempotent step runs out of
 * tries, DBOS throws a `DBOSMaxStepRetriesError` holding each try's error; this returns the
 * last one, so the ledger and the run record the vendor's error and its `code`. On a replay
 * DBOS revives the wrapper from the database, with the tries as plain objects.
 */
export function lastTry(err: unknown): unknown {
  const wrapped =
    err instanceof DBOSErrors.DBOSMaxStepRetriesError ||
    (err instanceof Error && DBOSErrors.getDBOSErrorCode(err) === MAX_RETRIES);
  const tries = wrapped ? (err as { errors?: unknown }).errors : undefined;
  const last = Array.isArray(tries) ? tries.at(-1) : undefined;
  if (last === undefined) return err;
  if (last instanceof Error || typeof last !== "object" || last === null) return last;
  // Own enumerable properties, `code` among them, survive the trip through the database.
  return Object.assign(new Error(String((last as { message?: unknown }).message ?? "")), last);
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
  const next = run.tail.then(call);
  // A failure rejects its caller, but the calls queued after it still run.
  run.tail = next.catch(() => {});
  return next;
}

/** The run's `ctx`: the operations and built-ins its workflow `uses`, and nothing else. */
export function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  const uses = wf.uses as readonly Use[];
  const tree: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (tree[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = (input: unknown) => serial(run, () => callOp(run, op.id, input));
  }
  for (const [v, resources] of Object.entries(tree)) {
    for (const [r, ops] of Object.entries(resources as Record<string, object>))
      resources[r] = strict(ops, `ctx.${v}.${r}`, wf.name);
    tree[v] = strict(resources, `ctx.${v}`, wf.name);
  }
  const builtins: Record<string, unknown> = {
    runId: run.id,
    now: () => serial(run, () => DBOS.now()),
  };
  if (uses.includes("approval"))
    builtins.approval = (title: string, req: ApprovalRequest) => serial(run, () => awaitApproval(run, title, req));
  if (uses.includes("sleep")) builtins.sleep = (req: unknown) => serial(run, () => sleep(req));
  return strict({ ...tree, ...builtins }, "ctx", wf.name);
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
export function checkDecision(decision: unknown, opId: string): RecordedDecision {
  const parsed = Decision.safeParse(decision);
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
    op: { id: op.id, vendor: op.vendor, resource: op.resource, name: op.name, effect: op.effect },
    effect: op.effect,
    ...targetOf(op, input),
    input,
    actor: run.actor,
    run: { id: run.id, workflow: run.workflow, approvals: structuredClone(run.approvals) },
  };
  const decision = checkDecision(await run.state.policy(call), op.id);
  const { policyVersion } = run.state;
  return policyVersion === undefined ? decision : { ...decision, policyVersion };
}

async function callOp(run: Run, id: string, input: unknown) {
  // The worker's declaration, never the workflow's: its effect, schemas and retry setting.
  const op = run.state.ops.get(id);
  const fn = run.state.drivers.get(id);
  if (!op || !fn) throw new Error(`No connector or driver for ${id} in this worker`);
  const checked = op.input.safeParse(input);
  if (!checked.success) {
    throw invalidInput(`The input to ${op.id} does not match its schema`, checked.error.issues, { op: op.id });
  }
  const parsed = checked.data;
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
    try {
      const held = { op: op.id, input: parsed, ...(decision.covers ? { covers: decision.covers } : {}) };
      await awaitApproval(run, title, { approver: decision.approver }, held);
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
      { name: op.id, retriesAllowed: op.idempotent, maxAttempts: 3, shouldRetry },
    );
  } catch (err) {
    // The step failed for good; on replay DBOS rethrows the recorded error, and this record
    // gets the same id. A success record would too, so a call has one op.called at most.
    const failure = lastTry(err);
    const record = entry(
      run,
      { ...call, error: errorInfo(failure), durationMs: Date.now() - started, ...(attempt ? { attempt } : {}) },
      { seq, at: started },
    );
    if (isInfrastructureError(err) || isInfrastructureError(failure)) {
      skipped(record, `the call was interrupted by DBOS (${errorMessage(err)})`);
      throw err;
    }
    await writeFailure(run, record, failure);
    throw failure;
  }
  const { output, at, durationMs } = result;
  await write(run, entry(run, { ...call, output, durationMs, attempt: result.attempt }, { seq, at }));
  return output;
}

/** Checks a sleep request before any DBOS call, so a bad one fails the run with `invalid_input`. */
function checkSleep(req: unknown): SleepRequest {
  const timed = typeof req === "object" && req !== null && "until" in req;
  const parsed = SleepRequest.options[timed ? 0 : 1].safeParse(req);
  if (parsed.success) return parsed.data;
  throw invalidInput(`ctx.sleep(${shown(req)})`, parsed.error.issues);
}

/**
 * An `invalid_input` error naming each problem, with zod's issues as plain JSON in `data`
 * (the shape `SanomaClient` uses), so they survive the trip through DBOS.
 */
function invalidInput(
  what: string,
  zodIssues: readonly { path: PropertyKey[]; message: string; code: string }[],
  data: Record<string, unknown> = {},
): SanomaError {
  const issues = zodIssues.map(({ path, message, code }) => ({
    path: path.filter((p) => typeof p !== "symbol"),
    message,
    code,
  }));
  const said = issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  return new SanomaError("invalid_input", `${what}: ${said}`, { ...data, issues });
}

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
