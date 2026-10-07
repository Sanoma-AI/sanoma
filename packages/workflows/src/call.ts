import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { awaitApproval } from "./approvals.ts";
import type { ApprovalRequest, SleepRequest, Use, WorkflowDefinition } from "./define.ts";
import { errorCode, errorInfo, errorMessage, PolicyDeniedError, type SanomaError } from "./errors.ts";
import { entry, skipped, write, writeFailure } from "./ledger.ts";
import { type CallContext, isOp, type Op } from "./op.ts";
import type { Decision } from "./policy.ts";
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

/** The run's `ctx`: the operations and built-ins its workflow `uses`, and nothing else. */
export function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  const uses = wf.uses as readonly Use[];
  const tree: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (tree[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = (input: unknown) => callOp(run, op.id, input);
  }
  for (const [v, resources] of Object.entries(tree)) {
    for (const [r, ops] of Object.entries(resources as Record<string, object>))
      resources[r] = strict(ops, `ctx.${v}.${r}`, wf.name);
    tree[v] = strict(resources, `ctx.${v}`, wf.name);
  }
  const builtins: Record<string, unknown> = {
    runId: run.id,
    now: () => DBOS.now(),
  };
  if (uses.includes("approval"))
    builtins.approval = (title: string, req: ApprovalRequest) => awaitApproval(run, title, req);
  if (uses.includes("sleep")) builtins.sleep = (req: SleepRequest) => sleep(req);
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

// A policy's answer. Parsing also copies it, so nothing else the policy returned is recorded.
const DecisionSchema: z.ZodType<Decision> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("allow") }),
    z.object({ kind: z.literal("deny"), reason: z.string({ error: "deny needs a reason" }) }),
    z.object({
      kind: z.literal("approve"),
      approver: z.string({ error: "approve needs an approver" }).regex(/\S/, "approve needs an approver"),
      title: z.string({ error: "the title must be a string" }).optional(),
    }),
  ],
  { error: "not a decision" },
);

/** Checks a policy's answer, and copies it so nothing else the policy returned is recorded. */
export function checkDecision(decision: unknown, opId: string): Decision {
  const parsed = DecisionSchema.safeParse(decision);
  if (parsed.success) return parsed.data;
  let shown: string;
  try {
    shown = JSON.stringify(decision) ?? String(decision);
  } catch {
    shown = String(decision);
  }
  const why = parsed.error.issues[0]?.message ?? "not a decision";
  throw new Error(`The policy returned ${shown} for ${opId}: ${why}; use allow(), deny(reason) or approve(approver)`);
}

/** Asks the policy. Runs inside a step, so it must have no side effects of its own. */
async function decide(run: Run, op: Op, input: unknown): Promise<Decision> {
  const decision = await run.state.policy({
    op,
    effect: op.effect,
    input,
    actor: run.actor,
    run: { id: run.id, workflow: run.workflow, approvals: structuredClone(run.approvals) },
  });
  return checkDecision(decision, op.id);
}

async function callOp(run: Run, id: string, input: unknown) {
  // The worker's declaration, never the workflow's: its effect, schemas and retry setting.
  const op = run.state.ops.get(id);
  const fn = run.state.drivers.get(id);
  if (!op || !fn) throw new Error(`No connector or driver for ${id} in this worker`);
  const parsed = op.input.parse(input);
  // The decision is recorded as a step, so a replay reuses it instead of asking a policy
  // that may have changed since. The policy must still be deterministic: a run that fails
  // before the step is recorded asks again.
  const decision = await DBOS.runStep(() => decide(run, op, parsed), { name: `policy:${op.id}` });
  const call = { type: "op.called", op: op.id, effect: op.effect, input: parsed, decision } as const;

  if (decision.kind === "deny") {
    const err = new PolicyDeniedError(op.id, decision.reason);
    await writeFailure(run, entry(run, { ...call, error: errorInfo(err), durationMs: 0 }), err);
    throw err;
  }
  if (decision.kind === "approve") {
    const title = decision.title ?? `${op.id} needs ${decision.approver}`;
    try {
      await awaitApproval(run, title, { approver: decision.approver }, { op: op.id, input: parsed });
    } catch (err) {
      if (errorCode(err) === "approval_rejected") {
        const approval = (err as SanomaError).data.approvalId as string;
        const record = entry(run, { ...call, approval, error: errorInfo(err), durationMs: 0 });
        await writeFailure(run, record, err);
      }
      throw err;
    }
  }

  // Take the seq outside the step: a replay skips the step body but must still count it.
  const seq = run.seq++;
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
      {
        name: op.id,
        retriesAllowed: op.idempotent,
        maxAttempts: 3,
        // A reply that doesn't match the output schema will not match on a retry either.
        shouldRetry: (e) => !isSchemaError(e),
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
    if (isInfrastructureError(err)) skipped(record, `the call was interrupted by DBOS (${errorMessage(err)})`);
    else await writeFailure(run, record, err);
    throw err;
  }
  const { output, at, durationMs } = result;
  await write(run, entry(run, { ...call, output, durationMs, attempt: result.attempt }, { seq, at }));
  return output;
}

async function sleep(req: SleepRequest) {
  let ms: number;
  if ("until" in req) {
    const target = typeof req.until === "number" ? req.until : Date.parse(req.until);
    if (Number.isNaN(target)) throw new Error(`ctx.sleep: "${req.until}" is not a date`);
    ms = target - (await DBOS.now());
  } else {
    ms =
      (req.ms ?? 0) +
      (req.seconds ?? 0) * 1_000 +
      (req.minutes ?? 0) * 60_000 +
      (req.hours ?? 0) * 3_600_000 +
      (req.days ?? 0) * 86_400_000;
  }
  if (ms > 0) await DBOS.sleep(ms);
}
