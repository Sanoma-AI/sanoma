import { DBOS, DBOSWorkflowConflictError, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { resolveDatabaseUrl, type SanomaConfig } from "./config.ts";
import type {
  ApprovalRequest,
  ApprovalResult,
  ApprovalState,
  SleepRequest,
  Use,
  WorkflowDefinition,
} from "./define.ts";
import { type LedgerRecord, type LedgerStore, memoryLedger } from "./ledger.ts";
import { type CallContext, type Connector, type Driver, isOp, type Op } from "./op.ts";
import { allow, approve, type Decision, deny, type Policy, PolicyDeniedError } from "./policy.ts";

export type { ApprovalState } from "./define.ts";

export const QUEUE = "sanoma";
export const APPROVALS_EVENT = "approvals";

export interface ApprovalMessage {
  decision: "approve" | "reject";
  by: string;
  note?: string;
}

/** What the DBOS workflow receives: the workflow's input and who started the run. */
export interface RunArgs {
  input: unknown;
  startedBy: string;
}

/** Who a run is recorded as started by when the caller doesn't say: `$USER`, else "unknown". */
export function defaultActor(): string {
  return process.env.USER || "unknown";
}

export class RejectedError extends Error {
  /** The approval's title. */
  readonly approval: string;
  readonly by: string;
  /** The approval's id in the run, such as "approval-2". */
  readonly approvalId?: string;

  constructor(approval: string, by: string, note?: string, approvalId?: string) {
    super(`"${approval}" was rejected by ${by}${note ? `: ${note}` : ""}`);
    this.name = "RejectedError";
    this.approval = approval;
    this.by = by;
    this.approvalId = approvalId;
  }
}

export interface WorkerOptions extends SanomaConfig {
  logLevel?: string;
}

// DBOS registrations are process-wide and survive shutdown, so the functions read
// drivers, policy and ledger from here at call time; a relaunch in the same process
// picks up new ones.
let drivers = new Map<string, Driver["ops"][string]>();
// The operations as the config's connectors declare them. A workflow's `uses` names an
// operation; the worker calls it with these effects, schemas and retry settings.
let trusted = new Map<string, Op>();
let policy: Policy | undefined;
let ledger: LedgerStore = memoryLedger();
// Bumped on stop. DBOS abandons a stopped worker's run functions, which then fail as their
// next DBOS call finds the database closed. Such a run must not record `run.failed`: the run
// recovered on the next worker records how it really ends.
let generation = 0;
const registered = new Map<
  string,
  { definition: WorkflowDefinition<any, any>; fn: (args: RunArgs) => Promise<unknown> }
>();

const warn = (message: string) => console.warn(`sanoma: ${message}`);

export interface Worker {
  start(workflow: string, input: unknown, options?: { runId?: string; startedBy?: string }): Promise<string>;
  stop(): Promise<void>;
}

/** Registers the workflows, connects to Postgres and recovers any runs that were interrupted. */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  // Check everything before touching the module state a running worker reads.
  if (!Array.isArray(options.connectors)) {
    throw new Error(
      "startWorker needs `connectors`: the defineConnector objects whose operations the drivers implement",
    );
  }
  const ops = indexConnectors(options.connectors);
  const impls = indexDrivers(options.drivers, ops);
  const names = new Map<string, WorkflowDefinition<any, any>>();
  for (const wf of options.workflows) {
    checkUses(wf, ops, impls);
    const other = names.get(wf.name) ?? registered.get(wf.name)?.definition;
    if (other && other !== wf) {
      throw new Error(
        `Two different workflow definitions are named "${wf.name}"; a name can be registered once per process`,
      );
    }
    names.set(wf.name, wf);
  }
  if (!options.policy) warn("no policy was given to startWorker, so every operation call is allowed");
  if (!options.ledger) {
    warn(
      "no ledger was given to startWorker, so records are kept in memory only and a separate client cannot read them",
    );
  }
  trusted = ops;
  drivers = impls;
  policy = options.policy;
  ledger = options.ledger ?? memoryLedger();
  for (const wf of options.workflows) {
    if (!registered.has(wf.name)) registered.set(wf.name, { definition: wf, fn: register(wf) });
  }
  DBOS.setConfig({
    name: options.appName ?? "sanoma",
    systemDatabaseUrl: resolveDatabaseUrl(options),
    logLevel: options.logLevel ?? "warn",
  });
  await DBOS.launch();
  await DBOS.registerQueue(QUEUE);
  return {
    async start(workflow, input, opts) {
      const fn = registered.get(workflow)?.fn;
      if (!fn) throw new Error(`No workflow named "${workflow}"`);
      const startedBy = opts?.startedBy ?? defaultActor();
      const handle = await DBOS.startWorkflow(fn, {
        workflowID: opts?.runId,
        queueName: QUEUE,
        authenticatedUser: startedBy,
      })({ input, startedBy });
      return handle.workflowID;
    },
    async stop() {
      generation++;
      await DBOS.shutdown();
    },
  };
}

/** What a run keeps in memory. Rebuilt the same way when DBOS replays the run. */
interface Run {
  id: string;
  workflow: string;
  actor: string;
  approvals: ApprovalState[];
  /** The next ledger `seq`. Advanced only outside steps, so a replay counts the same way. */
  seq: number;
  /** The worker generation this run function started in. */
  generation: number;
  ledger: LedgerStore;
}

type Common = "id" | "runId" | "seq" | "at" | "actor" | "workflow";
type Body = LedgerRecord extends infer R ? (R extends LedgerRecord ? Omit<R, Common> : never) : never;

function entry(run: Run, body: Body, opts: { seq?: number; key?: string; at?: number } = {}): LedgerRecord {
  const seq = opts.seq ?? run.seq++;
  return {
    id: `${run.id}:${body.type}:${opts.key ?? seq}`,
    runId: run.id,
    seq,
    at: opts.at ?? Date.now(),
    actor: run.actor,
    workflow: run.workflow,
    ...body,
  } as LedgerRecord;
}

/*
 * Every ledger write happens outside DBOS steps. When DBOS replays a run after a restart,
 * it re-runs the workflow function and these writes happen again with the same ids, so
 * the store keeps one of each and fills in any the interrupted run never got to write.
 */
async function write(run: Run, record: LedgerRecord) {
  await run.ledger.append(record);
}

/** Records a failure. If the ledger fails too, throws both, so neither is lost. */
async function writeFailure(run: Run, record: LedgerRecord, original: unknown) {
  try {
    await run.ledger.append(record);
  } catch (ledgerError) {
    throw new AggregateError(
      [original, ledgerError],
      `${errorMessage(original)} (and the ledger could not record ${record.id}: ${errorMessage(ledgerError)})`,
      { cause: ledgerError },
    );
  }
}

function skipped(record: LedgerRecord, why: string) {
  warn(`did not write ${record.type} ${record.id}: ${why}`);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// What DBOS throws into a run whose worker is shutting down. Verified for DBOS 5.2: a
// pending recv rejects with DBOSError("The system database has been shut down"), and a
// sleep or step that finishes after shutdown fails with pg's "Cannot use a pool after
// calling end on the pool". They are plain errors, so they are matched by message.
const SHUTDOWN =
  /system database has been shut down|System database shutting down|Cannot use a pool after calling end on the pool/;

/** True for errors that come from DBOS itself rather than the run: cancellation, lost ownership, shutdown. */
function isInfrastructureError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e instanceof DBOSErrors.DBOSWorkflowCancelledError || e instanceof DBOSWorkflowConflictError) return true;
    if (SHUTDOWN.test(e.message)) return true;
  }
  return false;
}

// Matched by name too, since a workflow's schemas may come from another copy of zod.
const isSchemaError = (err: unknown) => err instanceof Error && err.name === "ZodError";

function register(wf: WorkflowDefinition<any, any>) {
  return DBOS.registerWorkflow(
    async ({ input, startedBy }: RunArgs) => {
      const run: Run = {
        id: DBOS.workflowID!,
        workflow: wf.name,
        actor: startedBy,
        approvals: [],
        seq: 0,
        generation,
        ledger,
      };
      await write(run, entry(run, { type: "run.started", input }));
      let output: unknown;
      try {
        output = await wf.run(buildCtx(wf, run), wf.input.parse(input));
      } catch (err) {
        const record = entry(run, { type: "run.failed", error: errorMessage(err) });
        if (isInfrastructureError(err)) skipped(record, `the run was interrupted by DBOS (${errorMessage(err)})`);
        else if (run.generation !== generation)
          skipped(record, "its worker has stopped; the recovered run records the outcome");
        else await writeFailure(run, record, err);
        throw err;
      }
      await write(run, entry(run, { type: "run.finished", output }));
      return output;
    },
    { name: wf.name },
  );
}

function indexConnectors(list: Connector<any, any>[]) {
  const map = new Map<string, Op>();
  for (const connector of list) {
    for (const resource of Object.values(connector as Record<string, Record<string, unknown>>)) {
      for (const op of Object.values(resource)) {
        if (!isOp(op)) continue;
        const seen = map.get(op.id);
        if (seen && seen !== op) throw new Error(`Two connectors in \`connectors\` declare ${op.id}`);
        map.set(op.id, op);
      }
    }
  }
  return map;
}

function indexDrivers(list: Driver[], ops: Map<string, Op>) {
  const map = new Map<string, Driver["ops"][string]>();
  for (const d of list) {
    for (const [key, fn] of Object.entries(d.ops)) {
      const id = `${d.vendor}.${key}`;
      if (!ops.has(id)) {
        throw new Error(`Driver "${d.vendor}" implements ${id}, which no connector in \`connectors\` declares`);
      }
      map.set(id, fn);
    }
  }
  return map;
}

/**
 * Every operation a workflow uses must be one the config's connectors declare, with a driver.
 * The workflow normally imports the same connector object; a copy is accepted only if it
 * declares the same effect and retry setting, and the worker's declaration is used either way.
 */
function checkUses(wf: WorkflowDefinition<any, any>, ops: Map<string, Op>, impls: Map<string, unknown>) {
  const problems: string[] = [];
  for (const op of (wf.uses as readonly Use[]).filter(isOp)) {
    const known = ops.get(op.id);
    if (!known) problems.push(`${op.id} is not declared by any connector in \`connectors\``);
    else if (known !== op && (known.effect !== op.effect || known.idempotent !== op.idempotent)) {
      problems.push(
        `${op.id} is declared with effect "${op.effect}"${op.idempotent ? " (idempotent)" : ""}, ` +
          `but its connector says "${known.effect}"${known.idempotent ? " (idempotent)" : ""}`,
      );
    } else if (!impls.has(op.id)) problems.push(`${op.id} has no driver`);
  }
  if (problems.length) throw new Error(`Workflow "${wf.name}": ${problems.join("; ")}`);
}

function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
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

/** Checks a policy's answer, and copies it so nothing else the policy returned is recorded. */
function checkDecision(decision: unknown, opId: string): Decision {
  const d = (typeof decision === "object" && decision !== null ? decision : {}) as Record<string, unknown>;
  const refuse = (why: string) => {
    let shown: string;
    try {
      shown = JSON.stringify(decision) ?? String(decision);
    } catch {
      shown = String(decision);
    }
    return new Error(
      `The policy returned ${shown} for ${opId}: ${why}; use allow(), deny(reason) or approve(approver)`,
    );
  };
  switch (d.kind) {
    case "allow":
      return allow();
    case "deny":
      if (typeof d.reason !== "string") throw refuse("deny needs a reason");
      return deny(d.reason);
    case "approve":
      if (typeof d.approver !== "string" || !d.approver.trim()) throw refuse("approve needs an approver");
      if (d.title !== undefined && typeof d.title !== "string") throw refuse("the title must be a string");
      return approve(d.approver, d.title);
    default:
      throw refuse("not a decision");
  }
}

/** Asks the policy. Runs inside a step, so it must have no side effects of its own. */
async function decide(run: Run, op: Op, input: unknown): Promise<Decision> {
  if (!policy) return allow();
  const decision = await policy({
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
  const op = trusted.get(id);
  const fn = drivers.get(id);
  if (!op || !fn) throw new Error(`No connector or driver for ${id} in this worker`);
  const parsed = op.input.parse(input);
  // The decision is recorded as a step, so a replay reuses it instead of asking a policy
  // that may have changed since. The policy must still be deterministic: a run that fails
  // before the step is recorded asks again.
  const decision = await DBOS.runStep(() => decide(run, op, parsed), { name: `policy:${op.id}` });
  const call = { type: "op.called", op: op.id, effect: op.effect, input: parsed, decision } as const;

  if (decision.kind === "deny") {
    const err = new PolicyDeniedError(op.id, decision.reason);
    await writeFailure(run, entry(run, { ...call, error: err.message, durationMs: 0 }), err);
    throw err;
  }
  if (decision.kind === "approve") {
    const title = decision.title ?? `${op.id} needs ${decision.approver}`;
    try {
      await awaitApproval(run, title, { approver: decision.approver }, { op: op.id, input: parsed });
    } catch (err) {
      if (err instanceof RejectedError) {
        const record = entry(run, { ...call, approval: err.approvalId, error: err.message, durationMs: 0 });
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
      { ...call, error: errorMessage(err), durationMs: Date.now() - started, ...(attempt ? { attempt } : {}) },
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

/** A decision message as sent, or undefined if it is not one. */
function parseApprovalMessage(raw: unknown): ApprovalMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { by, decision, note } = raw as Record<string, unknown>;
  if (typeof by !== "string" || !by.trim()) return undefined;
  if (decision !== "approve" && decision !== "reject") return undefined;
  if (note !== undefined && typeof note !== "string") return undefined;
  return note === undefined ? { by, decision } : { by, decision, note };
}

function senderOf(raw: unknown): string | undefined {
  const by = typeof raw === "object" && raw !== null ? (raw as { by?: unknown }).by : undefined;
  return typeof by === "string" && by ? by : undefined;
}

async function awaitApproval(
  run: Run,
  title: string,
  req: ApprovalRequest,
  heldCall?: { op: string; input: unknown },
): Promise<ApprovalResult> {
  if (typeof req?.approver !== "string" || !req.approver.trim()) {
    throw new Error(`ctx.approval("${title}") needs an approver`);
  }
  const all = run.approvals;
  // Take the id and join the list before any await, so two approvals requested at once
  // (calls held by the policy inside Promise.all) get different ids and recv topics.
  const state: ApprovalState = {
    id: `approval-${all.length + 1}`,
    title,
    approver: req.approver,
    ...(req.links === undefined ? {} : { links: req.links }),
    ...(req.details === undefined ? {} : { details: req.details }),
    requestedBy: heldCall ? "policy" : "workflow",
    ...(heldCall ? { op: heldCall.op, input: heldCall.input } : {}),
    status: "pending",
    requestedAt: 0,
    refused: [],
  };
  all.push(state);
  state.requestedAt = await DBOS.now();
  await DBOS.setEvent(APPROVALS_EVENT, all);
  await write(
    run,
    entry(
      run,
      {
        type: "approval.requested",
        approval: state.id,
        title,
        approver: state.approver,
        requestedBy: state.requestedBy,
        ...(heldCall ? { op: heldCall.op } : {}),
      },
      { key: state.id, at: state.requestedAt },
    ),
  );
  for (;;) {
    const raw = await DBOS.recv<unknown>(state.id, { timeoutSeconds: 24 * 60 * 60 });
    if (raw === null || raw === undefined) {
      warn(`run ${run.id}: approval ${state.id} ("${title}") is still waiting for ${state.approver}`);
      continue;
    }
    const at = await DBOS.now();
    const msg = parseApprovalMessage(raw);
    if (!msg || msg.by !== state.approver) {
      const by = msg?.by ?? senderOf(raw);
      const reason = msg ? `${msg.by} is not the approver` : "not a valid decision message";
      state.refused.push(by === undefined ? { at, reason } : { by, at, reason });
      await DBOS.setEvent(APPROVALS_EVENT, all);
      await write(
        run,
        entry(
          run,
          { type: "approval.refused", approval: state.id, ...(by === undefined ? {} : { by }), reason },
          { key: `${state.id}:refused:${state.refused.length}`, at },
        ),
      );
      continue;
    }
    Object.assign(state, {
      status: msg.decision === "approve" ? "approved" : "rejected",
      decidedBy: msg.by,
      decidedAt: at,
      note: msg.note,
    });
    await DBOS.setEvent(APPROVALS_EVENT, all);
    await write(
      run,
      entry(
        run,
        { type: "approval.decided", approval: state.id, decision: msg.decision, by: msg.by, note: msg.note },
        { key: state.id, at },
      ),
    );
    if (msg.decision === "reject") throw new RejectedError(title, msg.by, msg.note, state.id);
    return { approvedBy: msg.by, at, note: msg.note };
  }
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
