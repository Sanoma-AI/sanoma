import type { ScenarioEntry } from "../api.ts";
import { fitsOp } from "@sanoma/workflows/shared";
import type { Graph, GraphNode, OpState } from "./types.ts";

/** What a scenario's steps do with an operation. */
export type ScenarioRoles = NonNullable<OpState["scenario"]>;

/**
 * What the steps about the operations `matches` picks do with them: `seeded` where a `Given`
 * seeds one, `fails` where a `Given` injects a fault into its next call, `expected` where a
 * `Then` expects a call to it, and `forbidden` where one expects none. Empty when no step is about one.
 */
export function scenarioRoles(steps: ScenarioEntry["steps"], matches: (op: string) => boolean): ScenarioRoles {
  const roles: ScenarioRoles = {};
  for (const { op, kind, called, fault } of steps) {
    if (op === undefined || !matches(op)) continue;
    if (kind === "given") roles[fault ? "fails" : "seeded"] = true;
    else if (called === false) roles.forbidden = true;
    else roles.expected = true;
  }
  return roles;
}

/**
 * A workflow's outline marked with what the scenario says of each operation (`scenarioRoles`).
 * An outline's op id with a computed segment (`*`) is marked for each operation it fits, as the
 * run graph matches it. Pure: the other nodes, and the graph, are returned as they are.
 */
export function annotateGraph(graph: Graph, { steps }: Pick<ScenarioEntry, "steps">): Graph {
  if (!steps.some((step) => step.op !== undefined)) return graph;
  const nodes = graph.nodes.map((node): GraphNode => {
    if (node.kind !== "op") return node;
    // `fitsOp` holds for the same id too.
    const scenario = scenarioRoles(steps, (op) => fitsOp(node.label, op));
    if (Object.keys(scenario).length === 0) return node;
    return { ...node, state: { ...node.state, scenario } };
  });
  return { ...graph, nodes };
}
