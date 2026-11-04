import type { WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import type { Db } from "./db.ts";

/** Metadata only: never read a run's inputs, outputs, error or authentication data. */
export type RunObservation = {
  runId: string;
  status: "missing" | "active" | "finished" | "failed" | "cancelled";
  workflow?: string;
};
export type InspectRun = (runId: string) => Promise<RunObservation>;

const statuses: Record<WorkflowStatusString, RunObservation["status"]> = {
  ENQUEUED: "active",
  DELAYED: "active",
  PENDING: "active",
  SUCCESS: "finished",
  ERROR: "failed",
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: "failed",
  CANCELLED: "cancelled",
};

/** A snapshot of the current application's run; unknown DBOS states remain active. */
export const inspectRun =
  (database: () => Promise<Db>, appName: string): InspectRun =>
  async (runId) => {
    const db = await database();
    const { rows } = await db.query<{ name: string; status: string }>(
      "SELECT name,status FROM dbos.workflow_status WHERE workflow_uuid=$1 AND application_name=$2",
      [runId, appName],
    );
    const row = rows[0];
    if (!row) return { runId, status: "missing" };
    return {
      runId,
      workflow: row.name,
      status: Object.hasOwn(statuses, row.status) ? statuses[row.status as WorkflowStatusString] : "active",
    };
  };
