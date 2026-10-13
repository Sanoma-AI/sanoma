import type { Box } from "../src/graph/layout.ts";
import type { GraphEdge, GraphNode } from "../src/graph/types.ts";

// What the graph tests compare a graph by.

/** Each edge as `source->target`. */
export const pairs = (edges: readonly GraphEdge[]) => edges.map((e) => `${e.source}->${e.target}`);

/** Each node's box with its clusters' corners added in: where it is on the page, not in its cluster. */
export function absolute(nodes: readonly GraphNode[], boxes: ReadonlyMap<string, Box>): Map<string, Box> {
  const out = new Map<string, Box>();
  // A cluster comes before the nodes inside it.
  for (const node of nodes) {
    const box = boxes.get(node.id)!;
    const parent = node.parent === undefined ? { x: 0, y: 0 } : out.get(node.parent)!;
    out.set(node.id, { ...box, x: box.x + parent.x, y: box.y + parent.y });
  }
  return out;
}

/** Each node as its id and its tone in a run, `-` when it has none. */
export const summary = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${("state" in n && n.state?.tone) || "-"}`);

/** Each node as its id and label, and the cluster it is drawn in. */
export const labels = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${n.label}${n.parent ? ` in ${n.parent}` : ""}`);

/** Each node as its id and its span in the source, as JSON: `null` when it has none. */
export const spans = (nodes: readonly GraphNode[]) => nodes.map((n) => `${n.id} ${JSON.stringify(n.span ?? null)}`);

/** Each node as its id and the text of its span up to the call's arguments: `-` when it has none. */
export const calls = (nodes: readonly GraphNode[], text: string) =>
  nodes.map((n) => `${n.id} ${n.span ? text.slice(...n.span).split("(")[0] : "-"}`);
