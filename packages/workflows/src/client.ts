import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { WorkflowDefinition } from "./define.ts";
import { APPROVALS_EVENT, type ApprovalMessage, type ApprovalState, QUEUE } from "./runtime.ts";

export interface RunSummary {
  runId: string;
  workflow: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  error?: string;
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

  private constructor(dbos: DBOSClient, appName: string) {
    this.dbos = dbos;
    this.appName = appName;
  }

  static async connect(databaseUrl: string, appName = "sanoma") {
    return new SanomaClient(await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: appName }), appName);
  }

  /** Validates the input against the workflow's schema, then queues a run for the worker. */
  async start(workflow: WorkflowDefinition<any, any>, input: unknown, runId?: string): Promise<string> {
    const parsed = workflow.input.parse(input);
    const handle = await this.dbos.enqueue(
      { queueName: QUEUE, workflowName: workflow.name, workflowID: runId, applicationName: this.appName },
      parsed,
    );
    return handle.workflowID;
  }

  async runs(limit = 20): Promise<RunSummary[]> {
    const rows = await this.dbos.listWorkflows({ limit, sortDesc: true, applicationName: this.appName, loadInput: false });
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

  /** Sends a decision on the run's pending approval (or the one named). The run checks who sent it. */
  async decide(runId: string, message: ApprovalMessage, approvalId?: string): Promise<ApprovalState> {
    const pending = (await this.approvals(runId)).filter((a) => a.status === "pending");
    const target = approvalId ? pending.find((a) => a.id === approvalId) : pending[0];
    if (!target) throw new Error(`Run ${runId} has no pending approval${approvalId ? ` "${approvalId}"` : ""}`);
    await this.dbos.send(runId, message, target.id);
    return target;
  }

  async result(runId: string, timeoutMs = 30_000): Promise<unknown> {
    return Promise.race([
      this.dbos.retrieveWorkflow(runId).getResult(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Run ${runId} still running`)), timeoutMs).unref()),
    ]);
  }

  close() {
    return this.dbos.destroy();
  }

  private async summarize(r: { workflowID: string; workflowName: string; status: string; createdAt: number; updatedAt?: number; error?: unknown }) {
    return {
      runId: r.workflowID,
      workflow: r.workflowName,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvals: await this.approvals(r.workflowID),
      error: r.error ? String((r.error as Error).message ?? r.error) : undefined,
    };
  }
}
