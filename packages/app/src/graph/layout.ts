import { Graph as Dagre, layout as dagreLayout } from "@dagrejs/dagre";
import type { Graph, GraphNodeKind } from "./types.ts";

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
  // Its icon, and in a run the UTC time it sleeps until.
  sleep: { width: 256, height: 40 },
  pending: { width: 112, height: 40 },
  cluster: { width: 112, height: 40 },
  split: { width: 24, height: 24 },
  skip: { width: 88, height: 28 },
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
 * Where each node goes, left to right in run order, by id, as React Flow places nodes. Lanes
 * share ranks and stack top to bottom in the order they were added: a `ctx.all`'s in member
 * order, a branch's in case order. A `cluster` is laid out first on its own, from the nodes
 * inside it, and then placed as one box (dagre cannot route edges to a box that holds nodes, and
 * React Flow wants a cluster's nodes relative to it anyway).
 */
export function layout({ nodes, edges }: Graph): Map<string, Box> {
  const children = Map.groupBy(nodes, (node) => node.parent);
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent]));
  // An edge joins two nodes in one box (the builder draws none across a cluster's edge).
  const links = Map.groupBy(edges, (edge) => parentOf.get(edge.source));
  const boxes = new Map<string, Box>();

  const place = (parent?: string) => {
    const inside = parent !== undefined;
    const g = new Dagre();
    // ranksep leaves the edges room between ranks; nodesep keeps stacked lanes apart.
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 20, marginx: inside ? 12 : 8, marginy: 8 });
    g.setDefaultEdgeLabel(() => ({}));
    const members = children.get(parent) ?? [];
    for (const node of members) {
      g.setNode(node.id, children.has(node.id) ? place(node.id) : { ...NODE_SIZE[node.kind] });
    }
    for (const edge of links.get(parent) ?? []) g.setEdge(edge.source, edge.target);
    // dagre's crossing reduction would reorder lanes that never cross, last member on top: the
    // order the nodes were added in is already free of crossings, and reads in member order.
    dagreLayout(g, { disableOptimalOrderHeuristic: true });
    const top = inside ? CLUSTER_HEADER : 0;
    for (const node of members) {
      // dagre gives each node's centre.
      const { x, y, width, height } = g.node(node.id) as Box;
      boxes.set(node.id, { x: x - width / 2, y: y - height / 2 + top, width, height });
    }
    const { width = 0, height = 0 } = g.graph();
    return { width, height: height + top };
  };
  place();
  return boxes;
}
