import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ApprovalRequest, ApprovalResult, SleepRequest, Use, WorkflowDefinition } from "./define.ts";
import { type Driver, isOp, type Op } from "./op.ts";

export const QUEUE = "sanoma";
export const APPROVALS_EVENT = "approvals";

export interface ApprovalState extends ApprovalRequest {
  id: string;
  title: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /** Decisions sent by someone other than the named approver, which were ignored. */
  refused: { by: string; at: number }[];
}

export interface ApprovalMessage {
  decision: "approve" | "reject";
  by: string;
  note?: string;
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

export interface WorkerOptions {
  workflows: WorkflowDefinition<any, any>[];
  drivers: Driver[];
  databaseUrl: string;
  /** Scopes workflows and queues in the system database. Defaults to "sanoma". */
  appName?: string;
  logLevel?: string;
}

// DBOS registrations are process-wide and survive shutdown, so the functions read
// drivers from here at call time; a relaunch in the same process picks up new ones.
let drivers = new Map<string, Driver["ops"][string]>();
const registered = new Map<string, (input: unknown) => Promise<unknown>>();

export interface Worker {
  start(workflow: string, input: unknown, options?: { runId?: string }): Promise<string>;
  stop(): Promise<void>;
}

/** Registers the workflows, connects to Postgres and recovers any runs that were interrupted. */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  drivers = indexDrivers(options.drivers);
  for (const wf of options.workflows) {
    checkDrivers(wf, drivers);
    if (!registered.has(wf.name)) registered.set(wf.name, register(wf));
  }
  DBOS.setConfig({
    name: options.appName ?? "sanoma",
    systemDatabaseUrl: options.databaseUrl,
    logLevel: options.logLevel ?? "warn",
  });
  await DBOS.launch();
  await DBOS.registerQueue(QUEUE);
  return {
    async start(workflow, input, opts) {
      const fn = registered.get(workflow);
      if (!fn) throw new Error(`No workflow named "${workflow}"`);
      const handle = await DBOS.startWorkflow(fn, { workflowID: opts?.runId, queueName: QUEUE })(input);
      return handle.workflowID;
    },
    stop: () => DBOS.shutdown(),
  };
}

function register(wf: WorkflowDefinition<any, any>) {
  return DBOS.registerWorkflow(
    async (input: unknown) => {
      const parsed = wf.input.parse(input);
      return wf.run(buildCtx(wf), parsed);
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

function buildCtx(wf: WorkflowDefinition<any, any>): any {
  const uses = wf.uses as readonly Use[];
  const tree: Record<string, any> = {};
  for (const op of uses.filter(isOp)) {
    const vendor = (tree[op.vendor] ??= {});
    const resource = (vendor[op.resource] ??= {});
    resource[op.name] = (input: unknown) => callOp(op, input);
  }
  for (const [v, resources] of Object.entries(tree)) {
    for (const [r, ops] of Object.entries(resources as Record<string, object>))
      resources[r] = strict(ops, `ctx.${v}.${r}`, wf.name);
    tree[v] = strict(resources, `ctx.${v}`, wf.name);
  }
  const approvals: ApprovalState[] = [];
  const builtins: Record<string, unknown> = {
    runId: DBOS.workflowID,
    now: () => DBOS.now(),
  };
  if (uses.includes("approval"))
    builtins.approval = (title: string, req: ApprovalRequest) => awaitApproval(approvals, title, req);
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

async function callOp(op: Op, input: unknown) {
  const parsed = op.input.parse(input);
  const fn = drivers.get(op.id);
  if (!fn) throw new Error(`No driver for ${op.id}`);
  return DBOS.runStep(async () => op.output.parse(await fn(parsed)), {
    name: op.id,
    retriesAllowed: op.idempotent,
    maxAttempts: 3,
  });
}

async function awaitApproval(all: ApprovalState[], title: string, req: ApprovalRequest): Promise<ApprovalResult> {
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
