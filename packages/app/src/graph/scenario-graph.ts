import type { ScenarioEntry } from "../api.ts";
import type { Tone } from "../lib/tone.ts";
import type { Graph, GraphNode } from "./types.ts";

/**
 * A workflow's outline marked with what the scenario says of each operation: a node whose
 * operation a `Given` step seeds (or makes fail) notes "seeded", in the idle tone; one a `Then`
 * step expects (or expects not to be called) notes "expected", in the waiting tone, and both
 * when both. Pure: the other nodes, and the graph, are returned as they are.
 */
export function annotateGraph(graph: Graph, { steps }: Pick<ScenarioEntry, "steps">): Graph {
  const kinds = new Map<string, Set<"given" | "then">>();
  for (const { op, kind } of steps) {
    if (op === undefined || kind === "when") continue;
    kinds.set(op, (kinds.get(op) ?? new Set()).add(kind));
  }
  if (kinds.size === 0) return graph;
  const nodes = graph.nodes.map((node): GraphNode => {
    if (node.kind !== "op") return node;
    const of = kinds.get(node.label);
    if (!of) return node;
    const note = [of.has("given") && "seeded", of.has("then") && "expected"].filter(Boolean).join(" · ");
    const tone: Tone = of.has("then") ? "waiting" : "idle";
    return { ...node, state: { ...node.state, tone, note } };
  });
  return { ...graph, nodes };
}
