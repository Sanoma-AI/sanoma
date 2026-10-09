import type { ScenarioEntry } from "../api.ts";
import { fits, type Graph, type GraphNode, type OpState } from "./types.ts";

/**
 * A workflow's outline marked with what the scenario says of each operation: `seeded` where a
 * `Given` step seeds it (or makes it fail), `expected` where a `Then` step expects a call to it,
 * and `forbidden` where one expects none. An outline's op id with a computed segment (`*`) is
 * marked for each operation it fits, as the run graph matches it. Pure: the other nodes, and
 * the graph, are returned as they are.
 */
export function annotateGraph(graph: Graph, { steps }: Pick<ScenarioEntry, "steps">): Graph {
  const about = steps.filter((step) => step.op !== undefined && step.kind !== "when");
  if (about.length === 0) return graph;
  const nodes = graph.nodes.map((node): GraphNode => {
    if (node.kind !== "op") return node;
    // `fits` holds for the same id too.
    const said = about.filter(({ op }) => fits(node.label, op!));
    if (said.length === 0) return node;
    const scenario: NonNullable<OpState["scenario"]> = {};
    for (const { kind, called } of said) {
      if (kind === "given") scenario.seeded = true;
      else if (called === false) scenario.forbidden = true;
      else scenario.expected = true;
    }
    return { ...node, state: { ...node.state, scenario } };
  });
  return { ...graph, nodes };
}
