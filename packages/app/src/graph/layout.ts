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

/** What a step's name adds to an operation's or a sleep's node, the line above its id or clock: measured in the browser. */
export const NAME_HEIGHT = 20;

/**
 * A node's box: its kind's, taller by a line for an operation or a sleep with a name, and for an
 * operation by the rows it draws with `ops`. A fresh object: dagre writes into it.
 */
export function nodeSize(node: GraphNode): { width: number; height: number } {
  if (node.kind === "sleep" && node.name) {
    return { width: NODE_SIZE.sleep.width, height: NODE_SIZE.sleep.height + NAME_HEIGHT };
  }
  if (node.kind !== "op") return { ...NODE_SIZE[node.kind] };
  const { width, height } = NODE_SIZE.op;
  const rows = node.ops ? LIST_HEADER + wildcardRows(node.label, node.ops).length * ROW_HEIGHT : 0;
  return { width, height: height + (node.name ? NAME_HEIGHT : 0) + rows };
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
 * (a cluster's corner added in). A route starts on its source's right side and ends on its
 * target's left side, at the middle of a node's; on a cluster's, at the height where the line
 * goes on inside it. An edge from a cluster to a node it holds starts on its left side, from its
 * inside, and one from a node it holds to the cluster ends on its right side.
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
 * A cluster laid out on its own: its size; the heights, from its top, where the line into it goes
 * on inside it (`enter`) and where the line out of it comes from (`exit`); and the routes of the
 * edges in it, from its corner.
 */
interface Inside {
  width: number;
  height: number;
  enter: number;
  exit: number;
  routes: Map<string, Point[]>;
}

/**
 * Lays the graph out left to right in run order. Lanes share ranks and stack top to bottom in the
 * order they were added: a `ctx.all`'s in member order, a branch's in case order. A `cluster` is
 * laid out first on its own, from the nodes inside it, and then placed as one box (dagre cannot
 * route edges to a box that holds nodes, and React Flow wants a cluster's nodes relative to it
 * anyway); its inside edges run from and to two points of no size (`ENTER`, `EXIT`) that dagre
 * places with what it holds, and the lines into and out of it meet them at their heights.
 *
 * Each edge follows dagre's route (`steps`): the line turns down only on a rank of edges, where no
 * node is. A step drawn halfway from source to target instead runs behind a wider node of the
 * target's rank.
 */
export function layout({ nodes, edges }: Graph): Layout {
  const children = Map.groupBy(nodes, (node) => node.parent);
  const nodeOf = new Map(nodes.map((node) => [node.id, node]));
  const links = Map.groupBy(
    edges.map((edge) => link(edge, nodeOf)),
    (each) => each.box,
  );
  const boxes = new Map<string, Box>();

  const place = (parent?: string): Inside => {
    const inside = parent !== undefined;
    const g = new Dagre();
    // ranksep leaves the edges room between ranks; nodesep keeps stacked lanes apart.
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 20, marginx: inside ? 12 : 8, marginy: 8 });
    g.setDefaultEdgeLabel(() => ({}));
    const members = children.get(parent) ?? [];
    const clusters = new Map<string, Inside>();
    for (const node of members) {
      if (node.kind !== "cluster") {
        g.setNode(node.id, nodeSize(node));
        continue;
      }
      const cluster = place(node.id);
      clusters.set(node.id, cluster);
      // dagre centres a node on its lane: as tall as it must be for the line into it to be its
      // middle, the line runs on straight from a node level with it.
      const half = Math.max(cluster.enter, cluster.height - cluster.enter);
      g.setNode(node.id, { width: cluster.width, height: 2 * half });
    }
    const own = links.get(parent) ?? [];
    if (inside) for (const side of [ENTER, EXIT]) g.setNode(side, { width: 0, height: 0 });
    for (const { v, w } of own) g.setEdge(v, w);
    // dagre's crossing reduction would reorder lanes that never cross, last member on top: the
    // order the nodes were added in is already free of crossings, and reads in member order.
    dagreLayout(g, { disableOptimalOrderHeuristic: true });
    const top = inside ? CLUSTER_HEADER : 0;
    const routes = new Map<string, Point[]>();
    for (const node of members) {
      // dagre gives each node's centre: a cluster's is where the line into it goes on.
      const { x, y, width, height } = g.node(node.id) as Box;
      const cluster = clusters.get(node.id);
      const box = cluster
        ? { x: x - width / 2, y: y - cluster.enter + top, width, height: cluster.height }
        : { x: x - width / 2, y: y - height / 2 + top, width, height };
      boxes.set(node.id, box);
      // Its edges' routes, from this box's corner rather than its own.
      for (const [id, route] of cluster?.routes ?? []) {
        routes.set(
          id,
          route.map((point) => ({ x: point.x + box.x, y: point.y + box.y })),
        );
      }
    }
    // An empty cluster still has room for its label.
    const { width = 0, height = 0 } = g.graph();
    const least = inside ? NODE_SIZE.cluster : { width: 0, height: 0 };
    const size = { width: Math.max(width, least.width), height: Math.max(height + top, least.height) };
    const [enter, exit] = inside ? [g.node(ENTER).y + top, g.node(EXIT).y + top] : [0, 0];
    // Where a line leaves a node, and where it arrives: the middle of its side, or a cluster's
    // heights, or this cluster's own inside left and right.
    const from = (v: string): Point => {
      if (v === ENTER) return { x: 0, y: enter };
      const box = boxes.get(v)!;
      return { x: box.x + box.width, y: box.y + (clusters.get(v)?.exit ?? box.height / 2) };
    };
    const to = (w: string): Point => {
      if (w === EXIT) return { x: size.width, y: exit };
      const box = boxes.get(w)!;
      return { x: box.x, y: box.y + (clusters.get(w)?.enter ?? box.height / 2) };
    };
    for (const { edge, v, w } of own) {
      // Between dagre's ends (the boxes' sides it cut), its points on each rank the edge crosses.
      const ranks = (g.edge(v, w).points as Point[]).slice(1, -1).map(({ x, y }) => ({ x, y: y + top }));
      routes.set(edge.id, steps(edge.id, from(v), ranks, to(w)));
    }
    return { ...size, enter, exit, routes };
  };
  return { boxes, routes: place().routes };
}

/**
 * A line from `from` to `to` through `ranks`, dagre's points on the ranks the edge crosses: down
 * at each edge rank's point, across at `from`'s height, then each node rank's point's, then `to`'s.
 * Only its corners.
 *
 * This leans on how dagre lays ranks out, which it does not document: to leave room for edge
 * labels it doubles each edge's minlen and halves ranksep (makeSpaceForEdgeLabels), so a rank of
 * edges lies between each two ranks of nodes, and an edge has a point on each rank it crosses: an
 * edge rank's, then a node rank's, and so on, ending on an edge rank's, an odd number. Any other
 * number throws, naming the edge, rather than draw a line that slants into its target. An odd
 * count can still come from a dagre that ranks differently (without the doubling, an edge over
 * two node ranks has one point); `routeProblems` in the layout tests catches those routes.
 */
function steps(id: string, from: Point, ranks: readonly Point[], to: Point): Point[] {
  if (ranks.length % 2 === 0) {
    throw new Error(`layout: dagre gave edge ${id} ${ranks.length} points between its ends, not an odd number`);
  }
  const line = [from];
  let y = from.y;
  // An edge rank's point, then the next node rank's: down at the one, on at the other's height.
  for (let i = 0; i < ranks.length; i += 2) {
    const { x } = ranks[i]!;
    const next = ranks[i + 1]?.y ?? to.y;
    line.push({ x, y }, { x, y: next });
    y = next;
  }
  line.push(to);
  // Only the corners: no point where the line goes on straight, nor one it does not move from.
  return line.filter((point, i) => {
    const [before, after] = [line[i - 1], line[i + 1]];
    if (!before || !after) return true;
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}
