import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { resolveDatabaseUrl } from "./config.ts";
import type { WorkflowDefinition } from "./define.ts";
import type { LedgerRecord, LedgerStore } from "./ledger.ts";
import {
  APPROVALS_EVENT,
  type ApprovalMessage,
  type ApprovalState,
  defaultActor,
  QUEUE,
  type RunArgs,
} from "./runtime.ts";

export interface RunSummary {
  runId: string;
  workflow: string;
  status: string;
  /** Who started the run, as passed to `start`. */
  startedBy?: string;
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  error?: string;
}

export interface ClientOptions {
  /** Defaults to "sanoma"; must match the worker's. */
  appName?: string;
  /** The worker's ledger store, so `ledger(runId)` can read it. */
  ledger?: LedgerStore;
}

export interface StartOptions {
  /** Recorded as the run's actor in the ledger and passed to the policy. Defaults to `$USER`, else "unknown". */
  startedBy?: string;
  /** Use this run id instead of a new one. Starting the same id twice returns the existing run. */
  runId?: string;
}

export interface RunStep {
  name: string;
  output: unknown;
  error: string | null;
  startedAt?: number;
  completedAt?: number;
}

/** Talks to the runtime from another process (the CLI), through the shared Postgres. */
export class SanomaClient {
  private readonly dbos: DBOSClient;
  private readonly appName: string;
  private readonly store?: LedgerStore;

  private constructor(dbos: DBOSClient, appName: string, store?: LedgerStore) {
    this.dbos = dbos;
    this.appName = appName;
    this.store = store;
  }

  /**
   * Connects to the runtime's Postgres. `options` may be just the app name (the older form).
   * Without `databaseUrl`, uses `SANOMA_DATABASE_URL`, then the local docker compose database.
   */
  static async connect(databaseUrl?: string, options: ClientOptions | string = {}) {
    const { appName = "sanoma", ledger } = typeof options === "string" ? { appName: options } : options;
    return new SanomaClient(
      await DBOSClient.create({ systemDatabaseUrl: resolveDatabaseUrl({ databaseUrl }), applicationName: appName }),
      appName,
      ledger,
    );
  }

  /** Validates the input against the workflow's schema, then queues a run for the worker. */
  async start(workflow: WorkflowDefinition<any, any>, input: unknown, options: StartOptions = {}): Promise<string> {
    const parsed = workflow.input.parse(input);
    const startedBy = options.startedBy ?? defaultActor();
    const args: RunArgs = { input: parsed, startedBy };
    const handle = await this.dbos.enqueue(
      {
        queueName: QUEUE,
        workflowName: workflow.name,
        workflowID: options.runId,
        applicationName: this.appName,
        authenticatedUser: startedBy,
      },
      args,
    );
    return handle.workflowID;
  }

  /** The run's audit record, in order. Needs the worker's ledger store, passed to `connect`. */
  async ledger(runId: string): Promise<LedgerRecord[]> {
    if (!this.store) throw new Error("This client has no ledger store: pass `ledger` to SanomaClient.connect");
    await this.mustExist(runId);
    return this.store.read(runId);
  }

  async runs(limit = 20): Promise<RunSummary[]> {
    const rows = await this.dbos.listWorkflows({
      limit,
      sortDesc: true,
      applicationName: this.appName,
      loadInput: false,
    });
    return Promise.all(rows.map((r) => this.summarize(r)));
  }

  async run(runId: string): Promise<RunSummary | undefined> {
    const row = await this.dbos.getWorkflow(runId);
    return row && this.summarize(row);
  }

  async steps(runId: string): Promise<RunStep[]> {
    const steps = (await this.dbos.listWorkflowSteps(runId)) ?? [];
    return steps
      .filter((s) => !s.name.startsWith("DBOS."))
      .map((s) => ({
        name: s.name,
        output: s.output,
        error: s.error ? String(s.error.message ?? s.error) : null,
        startedAt: s.startedAtEpochMs,
        completedAt: s.completedAtEpochMs,
      }));
  }

  async approvals(runId: string): Promise<ApprovalState[]> {
    return (await this.dbos.getEvent<ApprovalState[]>(runId, APPROVALS_EVENT, 0)) ?? [];
  }

  /**
   * Sends a decision on the run's pending approval (or the one named), as `message.by`.
   * Throws without sending when `by` is not the approver. The run checks the sender again.
   */
  async decide(runId: string, message: ApprovalMessage, approvalId?: string): Promise<ApprovalState> {
    const pending = (await this.approvals(runId)).filter((a) => a.status === "pending");
    const target = approvalId ? pending.find((a) => a.id === approvalId) : pending[0];
    if (!target) throw new Error(`Run ${runId} has no pending approval${approvalId ? ` "${approvalId}"` : ""}`);
    if (message.by !== target.approver) {
      throw new Error(`"${message.by}" is not the approver for ${target.id}; ${target.approver} is`);
    }
    await this.dbos.send(runId, message, target.id);
    // Best effort: if someone else's decision landed first, this one will never be read.
    const now = (await this.approvals(runId)).find((a) => a.id === target.id);
    const status = message.decision === "approve" ? "approved" : "rejected";
    if (
      now &&
      now.status !== "pending" &&
      (now.status !== status || now.decidedBy !== message.by || now.note !== message.note)
    ) {
      throw new Error(`${target.id} on run ${runId} was already ${now.status} by ${now.decidedBy}`);
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
    if (!(await this.dbos.getWorkflow(runId))) throw new Error(`No run ${runId}`);
  }

  private async summarize(r: {
    workflowID: string;
    workflowName: string;
    status: string;
    createdAt: number;
    updatedAt?: number;
    authenticatedUser?: string;
    error?: unknown;
  }): Promise<RunSummary> {
    return {
      runId: r.workflowID,
      workflow: r.workflowName,
      status: r.status,
      startedBy: r.authenticatedUser || undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvals: await this.approvals(r.workflowID),
      error: r.error ? String((r.error as Error).message ?? r.error) : undefined,
    };
  }
}
