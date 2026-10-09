import type { GraphEdge, GraphNode } from "../src/graph/types.ts";

// What the graph tests compare a graph by.

/** Each edge as `source->target`. */
export const pairs = (edges: readonly GraphEdge[]) => edges.map((e) => `${e.source}->${e.target}`);

/** Each node as its id and its tone in a run, `-` when it has none. */
export const summary = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${("state" in n && n.state?.tone) || "-"}`);

/** Each node as its id and label, and the cluster it is drawn in. */
export const labels = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${n.label}${n.parent ? ` in ${n.parent}` : ""}`);

/** Each node as its id and its spans in the source, as JSON: `null` when it has none. */
export const spans = (nodes: readonly GraphNode[]) => nodes.map((n) => `${n.id} ${JSON.stringify(n.spans ?? null)}`);

/** Each node as its id and the text of each of its spans up to the call's arguments: `-` when it has none. */
export const calls = (nodes: readonly GraphNode[], text: string) =>
  nodes.map((n) => `${n.id} ${n.spans?.map(([start, end]) => text.slice(start, end).split("(")[0]).join() ?? "-"}`);
