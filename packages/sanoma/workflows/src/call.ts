import type { ConnectionRef, ConnectionSnapshot } from "./connection.ts";
import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { awaitApproval } from "./approvals.ts";
import { offsetOf } from "./ast.ts";
import { scriptPath } from "./company-file.ts";
import {
  type Call,
  callsOf,
  checkApproval,
  checkSleep,
  ctxOf,
  inputOf,
  opCalled,
  outputsOf,
  type Placed,
  recorded,
  targetOf,
  untilOf,
} from "./ctx.ts";
import { AllMembers, type ApprovalState, type Principal, type WorkflowDefinition } from "./define.ts";
import {
  causes,
  errorCode,
  errorInfo,
  isFinal,
  keepCode,
  parseOrThrow,
  PolicyDeniedError,
  SanomaError,
} from "./errors.ts";
import type { Collection } from "./collection.ts";
import { currentGroup, entry, type LedgerBody, skipped, write, writeFailure } from "./ledger.ts";
import type { CallContext, Op } from "./op.ts";
import { callAt, callName, type CallNode } from "./outline.ts";
import { allowAll, type Decision, type Policy, type PolicyCall, policyOpOf, type RecordedDecision } from "./policy.ts";
import type { Run, StartHold, WorkerState } from "./run.ts";
import { reservedFor, runtimeHold } from "./change.ts";
import { isChangeOp } from "./resource.ts";
import { readPeople } from "./resources.ts";
import {
  APPLY_WORKFLOW,
  approverLabel,
  CALL_WORKFLOW,
  CHANGE_MERGE,
  DATA_VENDOR,
  errorMessage,
  fitsOp,
  isBatch,
  problemLine,
  type Saved,
  WORKFLOW_ACTION,
} from "./shared.ts";

/** DBOS took the run from this execution: it cancelled the run, or another process took it over. */
const takenByDbos = (err: unknown) =>
  causes(err).some((e) => e instanceof DBOSErrors.DBOSWorkflowCancelledError || e instanceof DBOSWorkflowConflictError);

/**
 * True for a failure that is not the run's outcome, so the ledger does not record it: DBOS
 * cancelled the run or another process took it over, or the run's worker is stopping and the
 * error has none of our codes. `stop()` marks the worker stopped before DBOS shuts down, so from
 * then on whatever fails without a code (DBOS's "system database has been shut down", pg's
 * closed pool) is the shutdown. `runWorkflow` then keeps DBOS from recording it, so the run
 * recovered on the next worker records how it ends.
 * A coded failure then (a driver's final answer, a denial, a rejection) is still the outcome:
 * DBOS records the run's error and never runs it again, so the ledger records it too. Narrower
 * than `isRunControlError`: DBOS's other errors (a run that is not deterministic) end the run
 * for good, and are recorded.
 */
export function isInfrastructureError(err: unknown, state: Pick<WorkerState, "stopped">): boolean {
  return takenByDbos(err) || (state.stopped && errorCode(err) === undefined);
}

/** How many times an idempotent operation is tried. */
const MAX_ATTEMPTS = 3;

// Matched by name too, since a workflow's schemas may come from another copy of zod.
const isSchemaError = (err: unknown) => err instanceof Error && err.name === "ZodError";

/**
 * Whether DBOS should try an idempotent step again: not when the reply failed the output
 * schema (it would fail again), and not when the error says its answer is final (`retryable:
 * false`: a `DriverError` for a 4xx, a `SecretStoreError` other than `unavailable`). Read by
 * property, never `instanceof`: the error may come from another copy of this package.
 */
function shouldRetry(err: unknown): boolean {
  return !isSchemaError(err) && !isFinal(err);
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
 * The run's `ctx` on DBOS (`ctxOf`): every member that writes a record is placed in the outline
 * where the workflow calls it (`placeCall`) and goes through the run's queue (`serial`), its
 * records carrying the node and the step's name; `ctx.now()` only reads DBOS's clock, queued.
 * `ctx.all` alone skips the queue: it makes no DBOS call or record itself, it only calls its
 * members, whose ctx calls are queued. Queued, it would hold the queue until its members
 * settled, and their calls, queued behind it, would never start.
 */
export function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  return ctxOf(wf, run, {
    place: (member, what) => placeCall(run, member, what),
    op: (op, input, at, connection) => serial(run, () => callOp(run, op.id, input, at, connection)),
    now: () => serial(run, () => DBOS.now()),
    approval: (title, req, at) => serial(run, () => awaitApproval(run, title, checkApproval(title, req), at)),
    sleep: (req, at) => serial(run, () => sleep(run, req, at)),
    // Placed, so it has its node.
    all: (list, at) => all(run, list, at.node!),
  });
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

/** The key of the record a collection's `save` or `delete` acts on. */
const keyOf = (op: Op, input: unknown, collection: Collection): string =>
  op.name === "save"
    ? ((input as { record: Record<string, unknown> }).record[collection.key] as string)
    : (input as { key: string }).key;

/** A batch's denied entries: each one's key, with its decision. */
function denialsOf(
  op: Op,
  calls: readonly Call[],
  decisions: readonly RecordedDecision[],
  collections: ReadonlyMap<string, Collection>,
): { key: string; decision: Extract<RecordedDecision, { kind: "deny" }> }[] {
  const collection = collections.get(op.resource)!;
  return calls.flatMap((c, i) => {
    const decision = decisions[i]!;
    return decision.kind === "deny" ? [{ key: keyOf(c.op, c.input, collection), decision }] : [];
  });
}

/**
 * The decision for a call from those of the calls it makes: a batch is denied when any entry is
 * (the reason naming each denied key), else held when any is (by the first hold), else allowed;
 * any other call's is its own.
 */
export function decisionOf(
  op: Op,
  calls: readonly Call[],
  decisions: readonly RecordedDecision[],
  collections: ReadonlyMap<string, Collection>,
): RecordedDecision {
  if (!isBatch(op)) return decisions[0]!;
  const version = decisions[0]?.policyVersion === undefined ? {} : { policyVersion: decisions[0].policyVersion };
  const denied = denialsOf(op, calls, decisions, collections);
  if (denied.length) {
    const reasons = [...new Set(denied.flatMap(({ decision }) => decision.reasons ?? []))];
    const reason = denied.map(({ key, decision }) => `${key}: ${decision.reason}`).join("; ");
    return { kind: "deny", reason, ...(reasons.length && { reasons }), ...version };
  }
  return decisions.find((d) => d.kind === "approve") ?? { kind: "allow", ...version };
}

/** The keys of a batch's denied entries and each one's reason, for its `policy_denied` (`denied`, `deniedFor`); nothing for any other call. */
export function deniedKeys(
  op: Op,
  calls: readonly Call[],
  decisions: readonly RecordedDecision[],
  collections: ReadonlyMap<string, Collection>,
): { denied?: string[]; deniedFor?: Record<string, string> } {
  if (!isBatch(op)) return {};
  const denials = denialsOf(op, calls, decisions, collections);
  return {
    denied: denials.map(({ key }) => key),
    deniedFor: Object.fromEntries(denials.map(({ key, decision }) => [key, decision.reason])),
  };
}

/** `decideEach` for one call. */
export async function decide(
  run: Run,
  op: Op,
  input: unknown,
  connection?: ConnectionSnapshot,
): Promise<RecordedDecision> {
  const [decision] = await decideEach(run, [{ op, input }], connection);
  return decision!;
}

/**
 * Asks the policy about each of the calls a call makes (`callsOf`), in order, with the record a
 * collection's `save` or `delete` replaces as `before` (`beforeOf`, each read keyed by its place).
 * The runtime's own rule first (`runtimeHold`, over the running instance's people): while it
 * holds or denies a call, the company's policy is not asked about it. Runs inside a step, so it
 * must have no side effects of its own.
 */
export async function decideEach(
  run: Run,
  calls: readonly Call[],
  connection?: ConnectionSnapshot,
): Promise<RecordedDecision[]> {
  const seen = {
    id: run.id,
    workflow: run.workflow,
    approvals: structuredClone(run.approvals).filter(
      (a) => a.requestedBy !== "policy" || a.connection === connection?.revision,
    ),
  };
  const { policy } = run.state;
  const decisions: RecordedDecision[] = [];
  for (const [i, { op, input }] of calls.entries()) {
    // Only a merge is the rule's: no other call reads the people's files.
    const held =
      op.id === CHANGE_MERGE ? runtimeHold(op.id, input, seen.approvals, readPeople(run.state.root).people) : undefined;
    if (held) {
      decisions.push(held);
      continue;
    }
    // Keyed by the call (`seq` was taken for it) and its place, so a fake answers each read afresh.
    const before = await beforeOf(policy, op, input, run.state.collections, (get, key) =>
      driverOf(run, get)?.(
        { key },
        {
          idempotencyKey: `${run.id}:${run.seq}:before${i ? `:${i}` : ""}`,
          runId: run.id,
          opId: get,
          attempt: 1,
          secrets: secretsOf(run),
        },
      ),
    );
    const call = { ...callOf(op, input, run.actor, seen), ...before, ...(connection && { connection }) };
    decisions.push(ask(policy, op.id, () => policy(call), run.state));
  }
  return decisions;
}

/** The run's function for an operation: its own fake's in a sandbox run, never a vendor's; else the driver's. */
const driverOf = (run: Run, id: string) => (run.sandbox === undefined ? run.state.drivers : run.fakeDrivers)?.get(id);

/** The secrets a run's calls read: its own in a sandbox run, else the stored ones. */
const secretsOf = (run: Run) => (run.sandbox === undefined ? run.state.secrets : run.fakeSecrets!);

/** One call of `op` as `actor` in `run`, as a policy sees it: a merge's `entity`, the change's facts. */
const callOf = (op: Op, input: unknown, actor: Principal, run: PolicyCall["run"]): PolicyCall => ({
  op: policyOpOf(op),
  effect: op.effect,
  ...targetOf(op, input),
  input,
  actor,
  run,
  ...(op.id === CHANGE_MERGE && { entity: (input as { facts: Record<string, unknown> }).facts }),
});

/**
 * For a collection's `save` or `delete`, the record it replaces or removes, read once with the
 * collection's `get` (`read`): `{ before }` when there is one, else nothing, and nothing read
 * under `allowAll`, which reads no call. A failed read is named, keeping its error's code.
 */
export async function beforeOf(
  policy: Policy,
  op: Op,
  input: unknown,
  collections: ReadonlyMap<string, Collection>,
  read: (get: string, key: unknown) => Promise<unknown> | undefined,
): Promise<{ before?: unknown }> {
  const collection = op.vendor === DATA_VENDOR ? collections.get(op.resource) : undefined;
  if (policy === allowAll || !collection || (op.name !== "save" && op.name !== "delete")) return {};
  const key = keyOf(op, input, collection);
  let saved: Saved | null | undefined;
  try {
    saved = (await read(`${DATA_VENDOR}.${op.resource}.get`, key)) as Saved | null | undefined;
  } catch (err) {
    if (takenByDbos(err)) throw err;
    throw keepCode(new Error(`Reading the record ${op.id} replaces failed: ${errorMessage(err)}`, { cause: err }), err);
  }
  return saved ? { before: saved.record } : {};
}

/**
 * Asks `policy` about one call of `op` as `actor` in `run`: a direct call
 * (`SanomaClient.call`), with the record a collection's write replaces as `before` (`beforeOf`).
 */
export function decideCall(
  policy: Policy,
  op: Op,
  input: unknown,
  actor: Principal,
  run: PolicyCall["run"],
  before: Pick<PolicyCall, "before" | "connection"> = {},
): RecordedDecision {
  const call = { ...callOf(op, input, actor, run), ...before };
  return ask(policy, op.id, () => policy(call));
}

/**
 * Asks the policy whether `actor` may start a run of `workflow` with `input` (`Policy.start`, the
 * action `workflow:<name>`), as `SanomaClient.start` does before it queues one.
 */
export function decideStart(
  policy: Policy,
  workflow: string,
  input: unknown,
  actor: Principal,
  approvals: readonly ApprovalState[] = [],
) {
  return ask(policy, `${WORKFLOW_ACTION}${workflow}`, () => policy.start(actor, workflow, input, approvals));
}

/** The approval a start's `approve` answer waits on: whom it asks, its title, and the rules that held it. */
export function startHoldOf(
  workflow: string,
  { approver, title, reasons }: Extract<Decision, { kind: "approve" }>,
): StartHold {
  return {
    approver,
    title: title ?? `${WORKFLOW_ACTION}${workflow} needs ${approverLabel(approver)}`,
    ...(reasons && { reasons }),
  };
}

/**
 * The policy's answer about `id` (`answer`), with its version. A policy that fails is named in
 * the error, with its error's code, unless the worker is stopping (`state`).
 */
function ask(
  policy: Policy,
  id: string,
  answer: () => Decision,
  state: Pick<WorkerState, "stopped"> = { stopped: false },
): RecordedDecision {
  let decision: Decision;
  try {
    decision = answer();
  } catch (err) {
    // Named here, so the run's error and the ledger say which call the policy failed on, with
    // the code the policy's error had.
    if (isInfrastructureError(err, state)) throw err;
    throw keepCode(new Error(`The policy failed deciding ${id}: ${errorMessage(err)}`, { cause: err }), err);
  }
  return policy.version === undefined ? decision : { ...decision, policyVersion: policy.version };
}

/**
 * Refuses a change operation (`isChangeOp`) aimed at an object the data files declare, which only
 * apply changes: an `update` or `delete` of an id the lockfile binds or a data file names, and a
 * `create` or `update` whose identity (what its type's `find` makes of `desired`) a data file
 * declares or the lockfile binds. Any other object is the workflow's own, its change an ordinary
 * write. While the files have problems, which objects they declare is not known, so it refuses.
 */
async function refuseDeclared(run: Run, op: Op, input: unknown) {
  const type = `${op.vendor}.${op.resource}`;
  const { id, desired } = input as { id?: unknown; desired?: Record<string, unknown> };
  const targets: string[] = [];
  if (op.name !== "create" && typeof id === "string") targets.push(id);
  const find = run.state.types.get(type)?.find;
  if (op.name !== "delete" && desired && find) {
    try {
      targets.push(find(desired));
    } catch (err) {
      throw new SanomaError(
        "invalid_input",
        `${op.id}: its desired names no ${type} (${errorMessage(err)}), so it cannot be told from a declared one`,
        { op: op.id, workflow: run.workflow },
      );
    }
  }
  if (!targets.length) return;
  const declared = await run.state.declaredObjects();
  if (declared.problems.length) {
    throw new SanomaError(
      "invalid_input",
      `${op.id} waits for the data files to be fixed, since only apply changes a declared resource: ${declared.problems.map(problemLine).join("; ")}`,
      { op: op.id, workflow: run.workflow },
    );
  }
  for (const target of targets) {
    const key = declared.keys.get(`${type} ${target}`);
    if (key === undefined) continue;
    throw new SanomaError(
      "invalid_input",
      `${op.id} changes ${key}, a declared resource, which only apply does: change the data file instead`,
      { op: op.id, workflow: run.workflow, declared: key },
    );
  }
}

async function callOp(run: Run, id: string, input: unknown, place: Placed, ref?: ConnectionRef) {
  // The worker's declaration, never the workflow's: its effect, schemas and retry setting.
  const op = run.state.ops.get(id);
  // A sandbox run calls its own fakes, never a vendor.
  const fn = driverOf(run, id);
  if (!op || !fn) {
    throw new Error(
      run.sandbox === undefined
        ? `No connector or driver for ${id} in this worker`
        : `No connector or fake for ${id} in this worker: no fake its connectors attach implements it`,
    );
  }
  // Only change takes a change's steps; `resolveConfig` refuses any other workflow that uses one.
  const reserved = reservedFor(op);
  if (reserved && !reserved.workflows.includes(run.workflow)) {
    throw new SanomaError("invalid_input", `${op.id} ${reserved.does}, which ${reserved.by}`, {
      op: op.id,
      workflow: run.workflow,
    });
  }
  const parsed = inputOf(op, input);
  // The calls this one makes (a batch's entries), each decided and recorded on its own.
  const calls = callsOf(op, parsed, run.state.ops);
  // The call's identity (its ledger seq and id, and the driver's idempotency key) is taken
  // before the first await, so it depends only on the order the workflow made its calls. A
  // replay skips the step bodies but counts the same way. A call held for an approval is
  // numbered before the approval's records, so its op.called sorts ahead of them. A batch
  // takes a seq per entry.
  const seq = run.seq;
  run.seq += calls.length;
  // The decision is recorded as a step, so a replay reuses it instead of asking a policy
  // that may have changed since. The policy must still be deterministic: a run that fails
  // before the step is recorded asks again.
  const connection = await DBOS.runStep(
    async () => {
      if (run.sandbox !== undefined) {
        if (!run.fakeConnection) throw new SanomaError("invalid_input", "Sandbox account state is unavailable");
        return run.fakeConnection(op.vendor, ref);
      }
      return run.state.connections?.select(op.vendor, ref, run.actor.id);
    },
    { name: `connection:${op.id}` },
  );
  const decideStep = () =>
    DBOS.runStep(
      async () => {
        if (run.sandbox === undefined) await run.state.connections?.assertCurrent(connection, run.actor.id);
        // Read in the step, so a replay reuses the first answer, and asked again after each
        // approval, so a call made after a long wait sees the files as they are then.
        if (run.workflow !== APPLY_WORKFLOW && isChangeOp(op, run.state.types)) await refuseDeclared(run, op, parsed);
        return decideEach(run, calls, connection);
      },
      { name: `policy:${op.id}` },
    );
  let decisions = await decideStep();
  let decision = decisionOf(op, calls, decisions, run.state.collections);
  // The records keep the first decisions: a hold stays a hold once its approval let the call through.
  const decided = decisions;
  const logged = recorded(op, parsed, run.workflow);
  /** The call's records, one per call it made, numbered from `seq`, each with its decision and what `outcome` says of it. */
  const records = (outcome: (i: number) => Partial<LedgerBody>, at?: number) =>
    calls.map((c, i) =>
      entry(
        run,
        {
          ...opCalled(c, run.workflow),
          ...place,
          decision: decided[i]!,
          ...(connection && { connection }),
          ...outcome(i),
        } as LedgerBody,
        { seq: seq + i, ...(at !== undefined && { at }) },
      ),
    );
  const writeFailures = async (outcome: (i: number) => Partial<LedgerBody>, err: unknown, at?: number) => {
    for (const record of records(outcome, at)) await writeFailure(run, record, err);
  };

  // Each hold is lifted in turn: once one is approved, the policy is asked again, with it.
  for (;;) {
    if (decision.kind === "deny") {
      const err = new PolicyDeniedError(
        op.id,
        decision.reason,
        deniedKeys(op, calls, decisions, run.state.collections),
      );
      // A deny after an approval is recorded as the deny, with its reason, not as the hold.
      await writeFailures((i) => ({ decision: decisions[i]!, error: errorInfo(err), durationMs: 0 }), err);
      throw err;
    }
    if (decision.kind !== "approve") break;
    const title = decision.title ?? `${op.id} needs ${approverLabel(decision.approver)}`;
    try {
      // A hold covers the call it held and the calls of a batch it held, each decided again once it is approved.
      const held = calls.filter((_, i) => decisions[i]!.kind === "approve").map((c) => c.op.id);
      const covers = [...new Set([op.id, ...held])];
      await awaitApproval(run, title, { approver: decision.approver, covers }, place, {
        op: op.id,
        seq,
        input: logged,
        reasons: decision.reasons,
        connection: connection?.revision,
      });
    } catch (err) {
      // A rejection or a withdrawal stops the call: it is recorded as failed, naming the approval.
      const code = errorCode(err);
      if (code === "approval_rejected" || code === "approval_withdrawn") {
        const approval = (err as SanomaError).data.approvalId as string;
        await writeFailures(() => ({ approval, error: errorInfo(err), durationMs: 0 }), err);
      }
      throw err;
    }
    decisions = await decideStep();
    decision = decisionOf(op, calls, decisions, run.state.collections);
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
        if (run.sandbox === undefined) await run.state.connections?.assertCurrent(connection, run.actor.id);
        const secrets = secretsOf(run);
        const context: CallContext = {
          idempotencyKey: `${run.id}:${seq}`,
          runId: run.id,
          opId: op.id,
          attempt,
          secrets,
          principal: run.actor,
          ...(connection && { connection }),
          // A call run is the person's direct call held for an approval: made as them, as it would have been.
          by: run.workflow === CALL_WORKFLOW ? run.actor.id : `run:${run.id}`,
        };
        // A live driver's `env` is checked here, inside the step, by the guard `indexDrivers` put
        // on its function: the refusal is the call's failure, recorded and never retried.
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
    // The step failed for good; on replay DBOS rethrows the recorded error, and these records
    // get the same ids. A success record would too, so a call has one op.called at most.
    const failed = () => ({ error: errorInfo(err), durationMs: Date.now() - started, ...(attempt ? { attempt } : {}) });
    if (isInfrastructureError(err, run.state)) {
      for (const record of records(failed, started)) skipped(record, `the call was interrupted (${errorMessage(err)})`);
    } else await writeFailures(failed, err, started);
    throw err;
  }
  const { output, at, durationMs } = result;
  const outputs = outputsOf(op, output);
  try {
    for (const record of records(
      (i) => ({ output: recorded(calls[i]!.op, outputs[i], run.workflow), durationMs, attempt: result.attempt }),
      at,
    )) {
      await write(run, record);
    }
  } catch (err) {
    // The vendor acted, and nothing records it. A workflow that caught this and called again
    // would repeat the side effect under a new key, so the run makes no further calls.
    run.ended = true;
    throw new Error(`${op.id} succeeded, but the ledger could not record it: ${errorMessage(err)}`, { cause: err });
  }
  return output;
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
 * ends. For a duration that is the record's `at` plus the duration. The start is DBOS's clock
 * (`DBOS.now()`, a step), so a replay reads back the first execution's and computes the same
 * deadline: the one the worker's deadlines register while the run waits.
 */
async function sleep(run: Run, raw: unknown, at: Placed) {
  const req = checkSleep(raw);
  const seq = run.seq++;
  const started = await DBOS.now();
  const until = untilOf(req, started);
  const ms = until - started;
  await write(run, entry(run, { type: "sleep.started", ...at, until }, { seq, at: started }));
  // A time already past waits not at all, and adds no sleep step. A sandbox run never waits.
  if (ms > 0 && run.sandbox === undefined) {
    await run.state.deadlines.waiting(run.id, { kind: "sleep", until }, () => DBOS.sleep(ms));
  }
}
