import type { Rebind } from "@sanoma-ai/workflows/describe";
import type { ApplyPlan, PlanStep } from "../apply-types.ts";

// The words and groups of the change view (components/apply-plan.tsx), without React.

/**
 * An approval's details as an apply plan, when they are one: the plan itself or its JSON, told
 * apart by its shape (problems, rebinds and steps, each a list).
 */
export function asApplyPlan(details: unknown): ApplyPlan | undefined {
  let value = details;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { problems, rebinds, steps } = value as Partial<Record<keyof ApplyPlan, unknown>>;
  return Array.isArray(problems) && Array.isArray(rebinds) && Array.isArray(steps) ? (value as ApplyPlan) : undefined;
}

/** A vendor's id short enough to read in a sentence; the whole of it goes in a title. */
export const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

/** A declaration's name in plain words: its export's, from `<file>#<export>`. */
export const exportName = (key: string) => key.slice(key.lastIndexOf("#") + 1);

/**
 * A change to the lockfile apply did not make, in plain words: "points store at a different
 * project: abcdefgh… → wxyzabcd…". `noun` names the binding's type, such as "project".
 */
export function rebindWords({ key, kind, from = "", to = "" }: Rebind, noun: string): string {
  const name = exportName(key);
  switch (kind) {
    case "rebind":
      return `points ${name} at a different ${noun}: ${shortId(from)} → ${shortId(to)}`;
    case "bind":
      return `points ${name} at an existing ${noun}: ${shortId(to)}`;
    case "unbind":
      return `forgets which ${noun} ${name} is: it was ${shortId(from)}`;
  }
}

export type PlanAction = PlanStep["action"];

/** The order the change view groups steps in, and each group's heading. */
export const STEP_GROUPS: [action: PlanAction, title: string][] = [
  ["create", "Create"],
  ["update", "Update"],
  ["replace", "Replace: delete, then create"],
  ["bind", "Bind to an existing object"],
  ["gone", "Gone at the vendor"],
  ["orphan", "No longer declared"],
  ["none", "Unchanged"],
];

/** The plan's steps by action, each group in the plan's (dependency) order. */
export function groupSteps(steps: PlanStep[]): Map<PlanAction, PlanStep[]> {
  const groups = new Map<PlanAction, PlanStep[]>();
  for (const step of steps) groups.set(step.action, [...(groups.get(step.action) ?? []), step]);
  return groups;
}

/** A create's fields: each planned value, then each path the vendor fills in (`known` false). */
export function plannedRows({
  planned,
  unknown,
}: {
  planned: Record<string, unknown>;
  unknown: string[];
}): { path: string; value?: unknown; known: boolean }[] {
  const later = new Set(unknown);
  return [
    ...Object.entries(planned)
      .filter(([path]) => !later.has(path))
      .map(([path, value]) => ({ path, value, known: true })),
    ...unknown.map((path) => ({ path, known: false })),
  ];
}
