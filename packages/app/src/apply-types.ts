import type { DriftField } from "@sanoma-ai/workflows";
import type { Rebind, ResourceProblem } from "@sanoma-ai/workflows/describe";

// The apply workflow's plan (contract C5), declared here until @sanoma-ai/workflows/describe
// exports it: delete this file then and import from there.

/** What apply does with a gone object or an orphaned binding, once a person says. */
export type PlanAnswer = "recreate" | "forget" | "delete";

/** One declared resource (or orphaned binding) in the plan, by what apply would do with it. */
export type PlanStep = { id: string; vendor: string; type: string } & (
  | { action: "create"; planned: Record<string, unknown>; unknown: string[] }
  | { action: "update" | "replace"; binding: string; fields: DriftField[]; replace: string[] }
  | { action: "bind"; binding: string; source: "found" | "given" }
  | { action: "gone"; binding: string; answer?: PlanAnswer }
  | { action: "orphan"; key: string; binding: string; answer?: PlanAnswer }
  | { action: "none"; binding: string }
);

/** What apply would change: the data files' problems, the lockfile's changes it did not make, and each step in dependency order. */
export interface ApplyPlan {
  problems: ResourceProblem[];
  rebinds: Rebind[];
  steps: PlanStep[];
}
