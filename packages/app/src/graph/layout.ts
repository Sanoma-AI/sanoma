import { Graph as Dagre, layout as dagreLayout } from "@dagrejs/dagre";
import type { Graph, GraphEdge, GraphNode, GraphNodeKind } from "./types.ts";
import { LIST_HEADER, ROW_HEIGHT, wildcardRows } from "./wildcard.ts";

/**
 * Each kind's box, in px. The node components draw to these sizes: an operation's two lines
 * (its id, then its effect, decision and duration badges) need the widest. A `cluster` is sized
 * to what it holds; this is its size when it holds nothing. An operation with `ops` is taller
 * by its rows (`nodeSize`).
 */
export const NODE_SIZE: Record<GraphNodeKind, { width: number; height: number }> = {
  start: { width: 96, height: 40 },
  end: { width: 112, height: 40 },
  op: { width: 232, height: 64 },
  approval: { width: 232, height: 64 },
  // Its clock, and in a run "until" the UTC time it sleeps until.
  sleep: { width: 232, height: 40 },
  pending: { width: 112, height: 40 },
  cluster: { width: 112, height: 40 },
  split: { width: 24, height: 24 },
  skip: { width: 88, height: 28 },
};

/** A node's box: its kind's, and for an operation with `ops`, taller by the rows it draws. A fresh object: dagre writes into it. */
export function nodeSize(node: GraphNode): { width: number; height: number } {
  if (node.kind !== "op" || !node.ops) return { ...NODE_SIZE[node.kind] };
  const { width, height } = NODE_SIZE.op;
  return { width, height: height + LIST_HEADER + wildcardRows(node.label, node.ops).length * ROW_HEIGHT };
}

/** The room a `cluster` leaves above what it holds, for its label. */
export const CLUSTER_HEADER = 28;

/** A node's top-left corner and size. Inside a `cluster`, the corner is relative to the cluster's. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where a graph's nodes and edges go: each node's `Box` by id, as React Flow places nodes, and
 * each edge's route by id, the corners of a line in straight runs across and down, on the page
 * (a cluster's corner added in). A route starts at the middle of its source's right side (of a
 * cluster's left side, from its inside) and ends at the middle of its target's left side (of a
 * cluster's right side, from its inside).
 */
export interface Layout {
  boxes: Map<string, Box>;
  routes: Map<string, Point[]>;
}

// A cluster's inside left and right, as two points dagre places with what the cluster holds.
const ENTER = "\0enter";
const EXIT = "\0exit";

/** An edge as dagre lays it out: the box it is drawn in, and its two ends in that box's graph. */
interface Link {
  edge: GraphEdge;
  box: string | undefined;
  v: string;
  w: string;
}

/**
 * Where an edge is drawn, from its nodes' `parent`: an edge from a cluster to a node it holds runs
 * in the cluster from its inside left (`ENTER`), one from a node it holds to the cluster to its
 * inside right (`EXIT`), and one from the cluster to itself (an empty body) across its inside.
 * Any other edge joins two nodes in one box. Throws, naming the edge, for one that does not.
 */
function link(edge: GraphEdge, nodeOf: ReadonlyMap<string, GraphNode>): Link {
  const { id, source, target } = edge;
  const [from, to] = [nodeOf.get(source), nodeOf.get(target)];
  if (from && to) {
    if (from === to && from.kind === "cluster") return { edge, box: source, v: ENTER, w: EXIT };
    if (to.parent === source) return { edge, box: source, v: ENTER, w: target };
    if (from.parent === target) return { edge, box: target, v: source, w: EXIT };
    if (from !== to && from.parent === to.parent) return { edge, box: from.parent, v: source, w: target };
  }
  throw new Error(`layout: edge ${id} joins neither two nodes in one box nor a cluster and a node it holds`);
}

/**
 * Lays the graph out left to right in run order. Lanes share ranks and stack top to bottom in the
 * order they were added: a `ctx.all`'s in member order, a branch's in case order. A `cluster` is
 * laid out first on its own, from the nodes inside it, and then placed as one box (dagre cannot
 * route edges to a box that holds nodes, and React Flow wants a cluster's nodes relative to it
 * anyway); its inside edges run from and to two points of no size at its sides.
 *
 * Each edge follows dagre's route: dagre puts a rank for edges between each two ranks of nodes,
 * and a point of each edge's on every rank it crosses. The line turns down only on an edge rank,
 * where no node is, and runs across at its source's, then each node rank's point's, then its
 * target's height. A step drawn halfway from source to target instead runs behind a wider node
 * of the target's rank.
 */
export function layout({ nodes, edges }: Graph): Layout {
  const children = Map.groupBy(nodes, (node) => node.parent);
  const nodeOf = new Map(nodes.map((node) => [node.id, node]));
  const links = Map.groupBy(
    edges.map((edge) => link(edge, nodeOf)),
    (each) => each.box,
  );
  const boxes = new Map<string, Box>();
  // Each edge's route in its box, and the box it is in.
  const local = new Map<string, { route: Point[]; parent: string | undefined }>();

  const place = (parent?: string) => {
    const inside = parent !== undefined;
    const g = new Dagre();
    // ranksep leaves the edges room between ranks; nodesep keeps stacked lanes apart.
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 20, marginx: inside ? 12 : 8, marginy: 8 });
    g.setDefaultEdgeLabel(() => ({}));
    const members = children.get(parent) ?? [];
    for (const node of members) {
      g.setNode(node.id, node.kind === "cluster" ? place(node.id) : nodeSize(node));
    }
    const own = links.get(parent) ?? [];
    if (inside) for (const side of [ENTER, EXIT]) g.setNode(side, { width: 0, height: 0 });
    for (const { v, w } of own) g.setEdge(v, w);
    // dagre's crossing reduction would reorder lanes that never cross, last member on top: the
    // order the nodes were added in is already free of crossings, and reads in member order.
    dagreLayout(g, { disableOptimalOrderHeuristic: true });
    const top = inside ? CLUSTER_HEADER : 0;
    for (const node of members) {
      // dagre gives each node's centre.
      const { x, y, width, height } = g.node(node.id) as Box;
      boxes.set(node.id, { x: x - width / 2, y: y - height / 2 + top, width, height });
    }
    // An empty cluster still has room for its label.
    const { width = 0, height = 0 } = g.graph();
    const least = inside ? NODE_SIZE.cluster : { width: 0, height: 0 };
    const size = { width: Math.max(width, least.width), height: Math.max(height + top, least.height) };
    for (const { edge, v, w } of own) {
      const from = v === ENTER ? { x: 0, y: size.height / 2 } : side(boxes.get(v)!, "right");
      const to = w === EXIT ? { x: size.width, y: size.height / 2 } : side(boxes.get(w)!, "left");
      // Between dagre's ends (the boxes' sides it cut), its points on each rank the edge crosses.
      const ranks = (g.edge(v, w).points as Point[]).slice(1, -1).map(({ x, y }) => ({ x, y: y + top }));
      local.set(edge.id, { route: steps(from, ranks, to), parent });
    }
    return size;
  };
  place();

  // Each cluster's corner on the page: a cluster comes before the nodes inside it.
  const corner = new Map<string | undefined, Point>([[undefined, { x: 0, y: 0 }]]);
  for (const node of nodes) {
    if (node.kind !== "cluster") continue;
    const { x, y } = boxes.get(node.id)!;
    const at = corner.get(node.parent)!;
    corner.set(node.id, { x: x + at.x, y: y + at.y });
  }
  const routes = new Map<string, Point[]>();
  for (const [id, { route, parent }] of local) {
    const at = corner.get(parent)!;
    routes.set(
      id,
      route.map(({ x, y }) => ({ x: x + at.x, y: y + at.y })),
    );
  }
  return { boxes, routes };
}

/** The middle of a box's left or right side. */
const side = (box: Box, which: "left" | "right"): Point => ({
  x: which === "left" ? box.x : box.x + box.width,
  y: box.y + box.height / 2,
});

/**
 * A line from `from` to `to` through dagre's points on the ranks between (`ranks`: an edge
 * rank's, then a node rank's, and so on, ending on an edge rank): down at each edge rank's point,
 * across at `from`'s height, each node rank's point's, then `to`'s. Only its corners.
 */
function steps(from: Point, ranks: readonly Point[], to: Point): Point[] {
  const downs = ranks.filter((_, i) => i % 2 === 0).map((point) => point.x);
  const levels = ranks.filter((_, i) => i % 2 === 1).map((point) => point.y);
  // dagre always gives an edge rank between two ranks of nodes; halfway if it does not.
  if (!downs.length) downs.push((from.x + to.x) / 2);
  const line = [from];
  let y = from.y;
  for (const [i, x] of downs.entries()) {
    const next = levels[i] ?? to.y;
    line.push({ x, y }, { x, y: next });
    y = next;
  }
  line.push(to);
  // Only the corners: no point where the line goes on straight.
  return line.filter((point, i) => {
    const [before, after] = [line[i - 1], line[i + 1]];
    if (!before || !after) return true;
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}
