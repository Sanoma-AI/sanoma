import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { GraphEdge, GraphNode, GraphNodeKind } from "./run-graph.ts";

/**
 * Each kind's box, in px. The node components draw to these sizes: an operation's two lines
 * (its id, then its effect, decision and duration badges) need the widest. A `cluster` is sized
 * to what it holds; this is its size when it holds nothing.
 */
export const NODE_SIZE: Record<GraphNodeKind, { width: number; height: number }> = {
  start: { width: 96, height: 40 },
  end: { width: 112, height: 40 },
  op: { width: 232, height: 64 },
  approval: { width: 232, height: 64 },
  sleep: { width: 232, height: 40 },
  cluster: { width: 112, height: 40 },
  split: { width: 24, height: 24 },
};

/** The room a `cluster` leaves above what it holds, for its label. */
export const CLUSTER_HEADER = 28;

/** A node's top-left corner and size. Inside a `cluster`, the corner is relative to the cluster's. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where each node goes, left to right in run order, by id, as React Flow places nodes. A
 * `ctx.all`'s branches share ranks and stack apart. A `cluster` is laid out first on its own,
 * from the nodes inside it, and then placed as one box (dagre cannot route edges to a box that
 * holds nodes, and React Flow wants a cluster's nodes relative to it anyway).
 */
export function layout(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const place = (parent: string | undefined, inside: boolean) => {
    const members = nodes.filter((n) => n.parent === parent);
    const g = new Graph();
    // ranksep leaves the edges room between ranks; nodesep keeps stacked branches apart.
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 20, marginx: inside ? 12 : 8, marginy: 8 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const node of members) {
      const holds = node.kind === "cluster" && nodes.some((n) => n.parent === node.id);
      g.setNode(node.id, holds ? place(node.id, true) : { ...NODE_SIZE[node.kind] });
    }
    for (const edge of edges) if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
    dagreLayout(g);
    const top = inside ? CLUSTER_HEADER : 0;
    for (const node of members) {
      // dagre gives each node's centre.
      const { x, y, width, height } = g.node(node.id) as Box;
      boxes.set(node.id, { x: x - width / 2, y: y - height / 2 + top, width, height });
    }
    const { width = 0, height = 0 } = g.graph();
    return { width, height: height + top };
  };
  place(undefined, false);
  return boxes;
}
