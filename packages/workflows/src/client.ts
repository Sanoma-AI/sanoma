import { randomUUID } from "node:crypto";
import { DBOSClient, type WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import { APPROVALS_EVENT, ApprovalMessage, decisionEventOf, mayDecide, topicOf, notApprover } from "./approvals.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { type ApprovalState, Principal, type WorkflowDefinition } from "./define.ts";
import { parseOrThrow, SanomaError } from "./errors.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { RunArgs } from "./run.ts";

/**
 * Where a run is: waiting on the queue, running, waiting for an approval, or ended.
 * `waiting` is `running` with an approval pending.
 */
export type RunStatus = "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled";

/**
 * The run status each DBOS status maps to. `waiting` is PENDING with an approval pending, so
 * only the approvals tell it from `running`. Keyed by every DBOS status, so one a later DBOS
 * adds fails to compile here until it is mapped.
 */
const FROM_DBOS: Record<WorkflowStatusString, Exclude<RunStatus, "waiting">> = {
  ENQUEUED: "queued",
  DELAYED: "queued",
  PENDING: "running",
  SUCCESS: "finished",
  ERROR: "failed",
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: "failed",
  CANCELLED: "cancelled",
};

/** A run's status from DBOS's, and whether it has an approval pending. */
export function runStatus(dbosStatus: string, approvals: readonly ApprovalState[]): RunStatus {
  // A status this DBOS did not have when the table was written: not ended as far as we know.
  const status = Object.hasOwn(FROM_DBOS, dbosStatus) ? FROM_DBOS[dbosStatus as WorkflowStatusString] : "running";
  return status === "running" && approvals.some((a) => a.status === "pending") ? "waiting" : status;
}

/** The DBOS statuses the run statuses come from; `running` and `waiting` both come from PENDING. */
export const dbosStatusesOf = (...statuses: RunStatus[]): WorkflowStatusString[] =>
  (Object.keys(FROM_DBOS) as WorkflowStatusString[]).filter((s) =>
    statuses.some((status) => FROM_DBOS[s] === (status === "waiting" ? "running" : status)),
  );

/** Which runs `SanomaClient.runs` lists. */
export interface RunsFilter {
  /** At most this many, newest first. Defaults to 20. */
  limit?: number;
  /** Only runs with this status. */
  status?: RunStatus;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  /** Who started the run, as passed to `start`. */
  startedBy?: Principal;
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  error?: string;
}

export interface StartOptions {
  /** Recorded as the run's actor in the ledger and passed to the policy. */
  startedBy: Principal;
  /** Use this run id instead of a new one. Starting the same id twice returns the existing run. */
  runId?: string;
}

/** Talks to the runtime from another process (the app, a script), through the shared Postgres. */
export class SanomaClient {
  private readonly dbos: DBOSClient;
  private readonly config: ResolvedConfig;

  private constructor(dbos: DBOSClient, config: ResolvedConfig) {
    this.dbos = dbos;
    this.config = config;
  }

  /**
   * Connects to the runtime's Postgres for the config's app. Checks the config first and throws
   * what the worker would refuse. Reads ledgers from the config's ledger store.
   */
  static async connect(config: SanomaConfig): Promise<SanomaClient> {
    const resolved = resolveConfig(config);
    const dbos = await DBOSClient.create({
      systemDatabaseUrl: resolved.databaseUrl,
      applicationName: resolved.appName,
    });
    return new SanomaClient(dbos, resolved);
  }

  /** Validates the input against the workflow's schema, then queues a run for the worker. */
  async start(workflow: WorkflowDefinition<any, any>, input: unknown, options: StartOptions): Promise<string> {
    const parsed = parseOrThrow(workflow.input, input, `The input does not match ${workflow.name}'s schema`);
    const startedBy = parseOrThrow(
      Principal,
      options?.startedBy,
      '`startedBy` must be a principal, such as { id: "alice" }',
    );
    const args: RunArgs = { input: parsed, startedBy };
    const handle = await this.dbos.enqueue(
      {
        queueName: this.config.queueName,
        workflowName: workflow.name,
        workflowID: options.runId,
        applicationName: this.config.appName,
        authenticatedUser: startedBy.id,
        authenticatedRoles: startedBy.groups ?? [],
      },
      args,
    );
    return handle.workflowID;
  }

  /** The run's audit record, in order. Needs the config's ledger store. */
  async ledger(runId: string): Promise<LedgerRecord[]> {
    if (!this.config.ledger) throw new Error("This client has no ledger store: the config has no `ledger`");
    await this.mustExist(runId);
    return this.config.ledger.read(runId);
  }

  /**
   * The app's runs, newest first: the latest `limit`, or the latest `limit` with a `status`.
   * Only the approvals tell `running` from `waiting`, so those read PENDING runs a page at a
   * time until `limit` have that status.
   */
  async runs({ limit = 20, status }: RunsFilter = {}): Promise<RunSummary[]> {
    const list = (more: { limit: number; offset?: number }) =>
      this.dbos.listWorkflows({
        ...more,
        status: status && dbosStatusesOf(status),
        sortDesc: true,
        applicationName: this.config.appName,
        loadInput: false,
        // The output holds the error a summary shows; only an ended run can have one.
        loadOutput: status === undefined || status === "failed" || status === "cancelled",
      });
    if (status !== "running" && status !== "waiting") {
      return Promise.all((await list({ limit })).map((r) => this.summarize(r)));
    }
    const pageSize = Math.max(limit * 2, 50);
    const found: RunSummary[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const rows = await list({ limit: pageSize, offset });
      for (const run of await Promise.all(rows.map((r) => this.summarize(r)))) {
        if (run.status === status) found.push(run);
      }
      if (found.length >= limit || rows.length < pageSize) return found.slice(0, limit);
    }
  }

  async run(runId: string): Promise<RunSummary | undefined> {
    const row = await this.dbos.getWorkflow(runId);
    return row && this.summarize(row);
  }

  async approvals(runId: string): Promise<ApprovalState[]> {
    return (await this.dbos.getEvent<ApprovalState[]>(runId, APPROVALS_EVENT, 0)) ?? [];
  }

  /**
   * Sends a decision on the run's pending approval (or the one named), as `message.by`, and
   * waits for the run to read it. Returns the approval as decided. Throws without sending when
   * `by` may not decide it (`not_approver`), when there is nothing to decide
   * (`no_pending_approval`, `run_not_found`), or when it is decided already (`already_decided`),
   * and throws `already_decided` too when another decision reached the run first.
   *
   * If the run does not read the decision within `timeoutSeconds` (30 by default; the worker
   * may be down), returns the approval as it stands, still `pending`: the decision stays
   * queued for the run, which reads it when it next runs.
   */
  async decide(
    runId: string,
    message: ApprovalMessage,
    approvalId?: string,
    options: { timeoutSeconds?: number } = {},
  ): Promise<ApprovalState> {
    const msg = parseOrThrow(ApprovalMessage, message, "Not a decision");
    const all = await this.approvals(runId);
    const target = approvalId ? all.find((a) => a.id === approvalId) : all.find((a) => a.status === "pending");
    if (target && target.status !== "pending") throw alreadyDecided(runId, target);
    if (!target) {
      // A run with no approvals may not exist at all.
      await this.mustExist(runId);
      throw new SanomaError(
        "no_pending_approval",
        `Run ${runId} has no pending approval${approvalId ? ` "${approvalId}"` : ""}`,
        { runId, ...(approvalId ? { approvalId } : {}) },
      );
    }
    if (!mayDecide(target, msg.by)) {
      throw new SanomaError("not_approver", `${notApprover(target, msg.by)} (${target.id})`, {
        runId,
        approvalId: target.id,
        approver: target.approver,
      });
    }
    // The id names this message, so the run's answer says whether it decided with it; as the
    // idempotency key, it also keeps a retried send from queueing the message twice.
    const id = msg.id ?? randomUUID();
    await this.dbos.send(runId, { ...msg, id }, topicOf(target.id), id);
    // DBOSClient does not LISTEN for events: it polls, every 10 s unless told otherwise. A
    // running worker answers within moments, so poll often at first, then once a second.
    const event = decisionEventOf(target.id);
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const soon = Math.min(2, timeoutSeconds);
    const decided =
      (await this.dbos.getEvent<ApprovalState>(runId, event, { timeoutSeconds: soon, pollingIntervalMs: 100 })) ??
      (timeoutSeconds > soon
        ? await this.dbos.getEvent<ApprovalState>(runId, event, {
            timeoutSeconds: timeoutSeconds - soon,
            pollingIntervalMs: 1000,
          })
        : null);
    const now = decided ?? (await this.approvals(runId)).find((a) => a.id === target.id) ?? target;
    if (now.status !== "pending" && now.decidedWith !== id) throw alreadyDecided(runId, now);
    return now;
  }

  async result(runId: string, timeoutMs = 30_000): Promise<unknown> {
    await this.mustExist(runId);
    return Promise.race([
      this.dbos.retrieveWorkflow(runId).getResult(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Run ${runId} still running`)), timeoutMs).unref()),
    ]);
  }

  close() {
    return this.dbos.destroy();
  }

  private async mustExist(runId: string) {
    if (!(await this.dbos.getWorkflow(runId))) throw new SanomaError("run_not_found", `No run ${runId}`, { runId });
  }

  private async summarize(r: {
    workflowID: string;
    workflowName: string;
    status: string;
    createdAt: number;
    updatedAt?: number;
    authenticatedUser?: string;
    authenticatedRoles?: string[];
    error?: unknown;
  }): Promise<RunSummary> {
    const approvals = await this.approvals(r.workflowID);
    const groups = r.authenticatedRoles ?? [];
    return {
      runId: r.workflowID,
      workflow: r.workflowName,
      status: runStatus(r.status, approvals),
      startedBy: r.authenticatedUser ? { id: r.authenticatedUser, ...(groups.length ? { groups } : {}) } : undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvals,
      error: r.error ? String((r.error as Error).message ?? r.error) : undefined,
    };
  }
}

const alreadyDecided = (runId: string, a: ApprovalState) =>
  new SanomaError("already_decided", `${a.id} on run ${runId} was already ${a.status} by ${a.decidedBy}`, {
    runId,
    approvalId: a.id,
    status: a.status,
    decidedBy: a.decidedBy,
  });
