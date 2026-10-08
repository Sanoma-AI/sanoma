import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { GraphEdge, GraphNode, GraphNodeKind } from "./run-graph.ts";

/**
 * Each kind's box, in px. The node components draw to these sizes: an operation's two lines
 * (its id, then its effect, decision and duration badges) need the widest.
 */
export const NODE_SIZE: Record<GraphNodeKind, { width: number; height: number }> = {
  start: { width: 96, height: 40 },
  end: { width: 112, height: 40 },
  op: { width: 232, height: 64 },
  approval: { width: 232, height: 64 },
  sleep: { width: 232, height: 40 },
};

export interface Position {
  x: number;
  y: number;
}

/**
 * Where each node goes, left to right in run order, by id: its top-left corner, as React Flow
 * places nodes. A `ctx.all`'s branches share ranks and stack apart.
 */
export function layout(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Position> {
  const g = new Graph();
  // ranksep leaves the edges room between ranks; nodesep keeps stacked branches apart.
  g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 20, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) g.setNode(node.id, { ...NODE_SIZE[node.kind] });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagreLayout(g);
  const positions = new Map<string, Position>();
  for (const node of nodes) {
    // dagre gives each node's centre.
    const { x, y, width, height } = g.node(node.id) as { x: number; y: number; width: number; height: number };
    positions.set(node.id, { x: x - width / 2, y: y - height / 2 });
  }
  return positions;
}
