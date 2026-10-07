import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { APPROVALS_EVENT, ApprovalMessage, mayDecide, statusOf, topicOf } from "./approvals.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { type ApprovalState, Principal, type WorkflowDefinition } from "./define.ts";
import { SanomaError } from "./errors.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { RunArgs } from "./run.ts";

/**
 * Where a run is: waiting on the queue, running, waiting for an approval, or ended.
 * `waiting` is `running` with an approval pending.
 */
export type RunStatus = "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled";

/** A run's status from DBOS's, and whether it has an approval pending. */
export function runStatus(dbosStatus: string, approvals: readonly ApprovalState[]): RunStatus {
  switch (dbosStatus) {
    case "ENQUEUED":
    case "DELAYED":
      return "queued";
    case "PENDING":
      return approvals.some((a) => a.status === "pending") ? "waiting" : "running";
    case "SUCCESS":
      return "finished";
    case "ERROR":
    case "MAX_RECOVERY_ATTEMPTS_EXCEEDED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      // A status a later DBOS adds: not ended as far as we know.
      return "running";
  }
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
    const parsed = valid(workflow.input, input, `The input does not match ${workflow.name}'s schema`);
    const startedBy = valid(Principal, options?.startedBy, '`startedBy` must be a principal, such as { id: "alice" }');
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

  async runs(limit = 20): Promise<RunSummary[]> {
    const rows = await this.dbos.listWorkflows({
      limit,
      sortDesc: true,
      applicationName: this.config.appName,
      loadInput: false,
    });
    return Promise.all(rows.map((r) => this.summarize(r)));
  }

  async run(runId: string): Promise<RunSummary | undefined> {
    const row = await this.dbos.getWorkflow(runId);
    return row && this.summarize(row);
  }

  async approvals(runId: string): Promise<ApprovalState[]> {
    return (await this.dbos.getEvent<ApprovalState[]>(runId, APPROVALS_EVENT, 0)) ?? [];
  }

  /**
   * Sends a decision on the run's pending approval (or the one named), as `message.by`.
   * Throws without sending when `by` may not decide it. The run checks the sender again.
   */
  async decide(runId: string, message: ApprovalMessage, approvalId?: string): Promise<ApprovalState> {
    const msg = valid(ApprovalMessage, message, "Not a decision");
    await this.mustExist(runId);
    const all = await this.approvals(runId);
    const target = approvalId ? all.find((a) => a.id === approvalId) : all.find((a) => a.status === "pending");
    if (target && target.status !== "pending") throw alreadyDecided(runId, target);
    if (!target) {
      throw new SanomaError(
        "no_pending_approval",
        `Run ${runId} has no pending approval${approvalId ? ` "${approvalId}"` : ""}`,
        { runId, ...(approvalId ? { approvalId } : {}) },
      );
    }
    if (!mayDecide(target, msg.by)) {
      throw new SanomaError(
        "not_approver",
        `"${msg.by.id}" is not the approver for ${target.id}; ${target.approver} is`,
        {
          runId,
          approvalId: target.id,
          approver: target.approver,
        },
      );
    }
    await this.dbos.send(runId, msg, topicOf(target.id));
    // Best effort: if someone else's decision landed first, this one will never be read.
    const now = (await this.approvals(runId)).find((a) => a.id === target.id);
    if (
      now &&
      now.status !== "pending" &&
      (now.status !== statusOf(msg.decision) || now.decidedBy !== msg.by.id || now.note !== msg.note)
    ) {
      throw alreadyDecided(runId, now);
    }
    return target;
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

/** The value, parsed by the schema, or an `invalid_input` error carrying zod's issues. */
function valid<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new SanomaError("invalid_input", `${what}: ${z.prettifyError(parsed.error)}`, {
    issues: parsed.error.issues.map(({ path, message, code }) => ({
      path: path.filter((p) => typeof p !== "symbol"),
      message,
      code,
    })),
  });
}
