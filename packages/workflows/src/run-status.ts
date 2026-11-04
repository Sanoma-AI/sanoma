import type { WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { workflowStatus } from "./db/dbos.ts";

/** Metadata only: never read a run's inputs, outputs, error or authentication data. */
export type RunObservation = {
  runId: string;
  status: "missing" | "active" | "finished" | "failed" | "cancelled" | "interrupted";
  workflow?: string;
};
export type InspectRun = (runId: string) => Promise<RunObservation>;

const statuses: Record<WorkflowStatusString, RunObservation["status"]> = {
  ENQUEUED: "active",
  DELAYED: "active",
  PENDING: "active",
  SUCCESS: "finished",
  ERROR: "failed",
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: "interrupted",
  CANCELLED: "cancelled",
};

/** A snapshot of the current application's run; unknown DBOS states remain active. */
export const inspectRun =
  (database: () => Promise<Db>, appName: string): InspectRun =>
  async (runId) => {
    const db = await database();
    const [row] = await db
      .select({ name: workflowStatus.name, status: workflowStatus.status })
      .from(workflowStatus)
      .where(and(eq(workflowStatus.workflowUuid, runId), eq(workflowStatus.applicationName, appName)));
    if (!row) return { runId, status: "missing" };
    return {
      runId,
      ...(row.name !== null && { workflow: row.name }),
      status: Object.hasOwn(statuses, row.status) ? statuses[row.status as WorkflowStatusString] : "active",
    };
  };
