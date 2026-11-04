import { pgSchema, text } from "drizzle-orm/pg-core";

// What the runtime reads of DBOS's own tables (dbos-sdk 5.2.11), in its schema `dbos`: the
// columns named here only. DBOS makes and migrates these tables (`DBOS.migrate`); no migration is
// generated from this model, and the runtime's one write to them is `stampVersion` (`db.ts`).

export const dbos = pgSchema("dbos");

/** Each run's status row. */
export const workflowStatus = dbos.table("workflow_status", {
  workflowUuid: text().primaryKey(),
  status: text().notNull(),
  name: text(),
  applicationName: text(),
  applicationVersion: text(),
});
