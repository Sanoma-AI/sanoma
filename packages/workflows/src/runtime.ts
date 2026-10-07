import { DBOS } from "@dbos-inc/dbos-sdk";
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
import { type Driver, isOp, type Op } from "./op.ts";
import { allow, type Decision, type Policy, PolicyDeniedError } from "./policy.ts";

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
  readonly approval: string;
  readonly by: string;

  constructor(approval: string, by: string, note?: string) {
    super(`"${approval}" was rejected by ${by}${note ? `: ${note}` : ""}`);
    this.name = "RejectedError";
    this.approval = approval;
    this.by = by;
  }
}

export interface WorkerOptions extends SanomaConfig {
  logLevel?: string;
}

// DBOS registrations are process-wide and survive shutdown, so the functions read
// drivers, policy and ledger from here at call time; a relaunch in the same process
// picks up new ones.
let drivers = new Map<string, Driver["ops"][string]>();
let policy: Policy | undefined;
let ledger: LedgerStore = memoryLedger();
// Bumped on stop. A run function left over from a stopped worker (DBOS abandons them on
// shutdown) must not write to the ledger: the recovered run on the next worker does.
let epoch = 0;
const registered = new Map<string, (args: RunArgs) => Promise<unknown>>();

export interface Worker {
  start(workflow: string, input: unknown, options?: { runId?: string; startedBy?: string }): Promise<string>;
  stop(): Promise<void>;
}

/** Registers the workflows, connects to Postgres and recovers any runs that were interrupted. */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  drivers = indexDrivers(options.drivers);
  policy = options.policy;
  ledger = options.ledger ?? memoryLedger();
  for (const wf of options.workflows) {
    checkDrivers(wf, drivers);
    if (!registered.has(wf.name)) registered.set(wf.name, register(wf));
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
      const fn = registered.get(workflow);
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
      epoch++;
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
  epoch: number;
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

async function write(run: Run, record: LedgerRecord) {
  if (run.epoch === epoch) await run.ledger.append(record);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function register(wf: WorkflowDefinition<any, any>) {
  return DBOS.registerWorkflow(
    async ({ input, startedBy }: RunArgs) => {
      const run: Run = {
        id: DBOS.workflowID!,
        workflow: wf.name,
        actor: startedBy,
        approvals: [],
        seq: 0,
        epoch,
        ledger,
      };
      // Records written outside a step are written again when DBOS replays the run;
      // their ids repeat, so the ledger keeps the first.
      await write(run, entry(run, { type: "run.started", input }));
      try {
        const output = await wf.run(buildCtx(wf, run), wf.input.parse(input));
        await write(run, entry(run, { type: "run.finished", output }));
        return output;
      } catch (err) {
        await write(run, entry(run, { type: "run.failed", error: errorMessage(err) }));
        throw err;
      }
    },
    { name: wf.name },
  );
}

function indexDrivers(list: Driver[]) {
  const map = new Map<string, Driver["ops"][string]>();
  for (const d of list) {
    for (const [key, fn] of Object.entries(d.ops)) map.set(`${d.vendor}.${key}`, fn);
  }
  return map;
}

function checkDrivers(wf: WorkflowDefinition<any, any>, map: Map<string, unknown>) {
  const missing = (wf.uses as readonly Use[]).filter((u): u is Op => isOp(u) && !map.has(u.id)).map((u) => u.id);
  if (missing.length) {
    throw new Error(`Workflow "${wf.name}" uses operations with no driver: ${missing.join(", ")}`);
  }
}

function buildCtx(wf: WorkflowDefinition<any, any>, run: Run): any {
  const uses = wf.uses as readonly Use[];
  const tree: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (tree[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = (input: unknown) => callOp(run, op, input);
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

async function decide(run: Run, op: Op, input: unknown): Promise<Decision> {
  if (!policy) return allow();
  const decision = await policy({
    op,
    effect: op.effect,
    input,
    actor: run.actor,
    run: { id: run.id, workflow: run.workflow, approvals: run.approvals },
  });
  if (decision?.kind !== "allow" && decision?.kind !== "deny" && decision?.kind !== "approve") {
    throw new Error(`The policy returned ${JSON.stringify(decision)} for ${op.id}; use allow(), deny() or approve()`);
  }
  return decision;
}

async function callOp(run: Run, op: Op, input: unknown) {
  const parsed = op.input.parse(input);
  const fn = drivers.get(op.id);
  if (!fn) throw new Error(`No driver for ${op.id}`);
  // The policy runs outside a step, so it is asked again on replay; it must decide the same way.
  const decision = await decide(run, op, parsed);
  const call = { type: "op.called", op: op.id, effect: op.effect, input: parsed, decision } as const;

  if (decision.kind === "deny") {
    const err = new PolicyDeniedError(op.id, decision.reason);
    await write(run, entry(run, { ...call, error: err.message, durationMs: 0 }));
    throw err;
  }
  if (decision.kind === "approve") {
    await awaitApproval(run, decision.title ?? `${op.id} needs ${decision.approver}`, {
      approver: decision.approver,
    });
  }

  // Take the seq outside the step: a replay skips the step body but must still count it.
  const seq = run.seq++;
  const started = Date.now();
  try {
    // The vendor call and its ledger record share one step body, so both happen once:
    // a replay returns the recorded output without running the body again.
    return await DBOS.runStep(
      async () => {
        const t0 = Date.now();
        const output = op.output.parse(await fn(parsed));
        await write(run, entry(run, { ...call, output, durationMs: Date.now() - t0 }, { seq, at: t0 }));
        return output;
      },
      { name: op.id, retriesAllowed: op.idempotent, maxAttempts: 3 },
    );
  } catch (err) {
    // The step failed for good (DBOS rethrows the recorded error on replay). Same id as
    // a success record would have, so at most one op.called is kept for this call.
    await write(
      run,
      entry(run, { ...call, error: errorMessage(err), durationMs: Date.now() - started }, { seq, at: started }),
    );
    throw err;
  }
}

async function awaitApproval(run: Run, title: string, req: ApprovalRequest): Promise<ApprovalResult> {
  const all = run.approvals;
  const state: ApprovalState = {
    id: `approval-${all.length + 1}`,
    title,
    ...req,
    status: "pending",
    requestedAt: await DBOS.now(),
    refused: [],
  };
  all.push(state);
  await DBOS.setEvent(APPROVALS_EVENT, all);
  await write(
    run,
    entry(
      run,
      { type: "approval.requested", approval: state.id, title, approver: req.approver },
      { key: state.id, at: state.requestedAt },
    ),
  );
  for (;;) {
    const msg = await DBOS.recv<ApprovalMessage>(state.id, { timeoutSeconds: 24 * 60 * 60 });
    if (!msg) continue;
    const at = await DBOS.now();
    if (msg.by !== req.approver) {
      state.refused.push({ by: msg.by, at });
      await DBOS.setEvent(APPROVALS_EVENT, all);
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
    if (msg.decision === "reject") throw new RejectedError(title, msg.by, msg.note);
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
