import { describe, expect, it } from "vitest";
import { type Box, CLUSTER_HEADER, layout, NODE_SIZE, nodeSize, type Point } from "../src/graph/layout.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import type { Graph, GraphEdge } from "../src/graph/types.ts";
import { LIST_HEADER, MAX_ROWS, ROW_HEIGHT } from "../src/graph/wildcard.ts";
import { absolute, DRIFT_SHAPE } from "./graph-helpers.ts";

const op = (id: string) => ({ kind: "op", id }) as const;

const text = ({ x, y }: Point) => `(${x}, ${y})`;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** True when the segment from `a` to `b` runs through the inside of `box`, not along or outside its border. */
function crosses(a: Point, b: Point, box: Box): boolean {
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 < box.x + box.width && x2 > box.x && y1 < box.y + box.height && y2 > box.y;
}

/**
 * What is wrong with each edge's route, as text. None when it starts on its source's right side
 * and ends on its target's left side (a cluster's left side, from its inside, for an edge from
 * the cluster to a node it holds or across it; its right side for one back to it), at the middle
 * of a node's side and below a cluster's label; runs in straight lines across and down through no
 * other node's box; and, at a cluster's side, goes on where the line on the other side of it
 * ends, with no step at the border.
 */
function routeProblems(graph: Graph): string[] {
  const { boxes, routes } = layout(graph);
  const at = absolute(graph.nodes, boxes);
  const nodeOf = new Map(graph.nodes.map((n) => [n.id, n]));
  const around = (id: string): string[] => {
    const parent = nodeOf.get(id)!.parent;
    return parent === undefined ? [id] : [id, ...around(parent)];
  };
  /** True when `point` is on the `side` of `id`'s box: a node's middle, or a cluster's below its label. */
  const on = (point: Point, id: string, side: "left" | "right") => {
    const box = at.get(id)!;
    if (point.x !== (side === "left" ? box.x : box.x + box.width)) return false;
    return nodeOf.get(id)!.kind === "cluster"
      ? point.y > box.y + CLUSTER_HEADER && point.y < box.y + box.height
      : point.y === box.y + box.height / 2;
  };
  // Each cluster's sides, as the edges inside and outside it meet them.
  const inside = (edge: GraphEdge, cluster: string) =>
    edge.source === edge.target || nodeOf.get(cluster === edge.source ? edge.target : edge.source)!.parent === cluster;
  const problems = graph.edges.flatMap((edge) => {
    const route = routes.get(edge.id);
    if (!route) return [`${edge.id} has no route`];
    const [start, end] = [route[0]!, route.at(-1)!];
    const found: string[] = [];
    if (!on(start, edge.source, inside(edge, edge.source) ? "left" : "right")) {
      found.push(`${edge.id} starts at ${text(start)}, off its source's side`);
    }
    if (!on(end, edge.target, inside(edge, edge.target) ? "right" : "left")) {
      found.push(`${edge.id} ends at ${text(end)}, off its target's side`);
    }
    const own = new Set([...around(edge.source), ...around(edge.target)]);
    for (const [i, a] of route.slice(0, -1).entries()) {
      const b = route[i + 1]!;
      if (a.x !== b.x && a.y !== b.y) found.push(`${edge.id} runs aslant from ${text(a)} to ${text(b)}`);
      for (const node of graph.nodes) {
        if (!own.has(node.id) && crosses(a, b, at.get(node.id)!)) found.push(`${edge.id} runs behind ${node.id}`);
      }
    }
    return found;
  });
  for (const cluster of graph.nodes.filter((n) => n.kind === "cluster")) {
    const ends = (id: string, side: "start" | "end") =>
      graph.edges
        .filter((e) => (side === "start" ? e.source : e.target) === id)
        .map((e) => ({
          id: e.id,
          point: side === "start" ? routes.get(e.id)![0]! : routes.get(e.id)!.at(-1)!,
          inner: inside(e, id),
        }));
    const [arrive, leave] = [ends(cluster.id, "end"), ends(cluster.id, "start")];
    // Left: the lines into it, and the lines on inside it. Right: the lines back to it, and out of it.
    const pairs = [
      [arrive.filter((e) => !e.inner), leave.filter((e) => e.inner)],
      [arrive.filter((e) => e.inner), leave.filter((e) => !e.inner)],
    ] as const;
    for (const [into, onwards] of pairs) {
      for (const a of into) {
        for (const b of onwards) {
          if (!same(a.point, b.point))
            problems.push(`${a.id} ends at ${text(a.point)}, but ${b.id} starts at ${text(b.point)}`);
        }
      }
    }
  }
  return problems;
}

describe("layout", () => {
  it("makes an operation with the operations it can reach taller by its rows, and lays its neighbours out around it", () => {
    const ops = ["a.x.read", "b.y.read", "c.z.read"];
    const graph = outlineGraph([{ kind: "op", id: "*.*.read", ops }, op("d.w.after")]);
    const tall = graph.nodes[1]!;
    expect(nodeSize(tall)).toEqual({
      width: NODE_SIZE.op.width,
      height: NODE_SIZE.op.height + LIST_HEADER + 3 * ROW_HEIGHT,
    });
    expect(nodeSize(graph.nodes[2]!)).toEqual(NODE_SIZE.op);
    expect(layout(graph).boxes.get(tall.id)!.height).toBe(nodeSize(tall).height);
    // Past MAX_ROWS the list collapses, so the node stops growing.
    const many = Array.from({ length: 20 }, (_, i) => `v.r${i}.read`);
    expect(nodeSize({ id: "x", kind: "op", label: "*.*.read", ops: many }).height).toBe(
      NODE_SIZE.op.height + LIST_HEADER + MAX_ROWS * ROW_HEIGHT,
    );
  });

  it("lays a graph out left to right", () => {
    const graph = outlineGraph([op("a.x.one")]);
    const at = layout(graph).boxes;
    const xs = graph.nodes.map((n) => at.get(n.id)!.x);
    expect(xs[0]! + NODE_SIZE.start.width).toBeLessThan(xs[1]!);
    expect(xs[1]! + NODE_SIZE.op.width).toBeLessThan(xs[2]!);
  });

  it("puts a fan-out's lanes on one rank, stacked top to bottom in member order", () => {
    const graph = outlineGraph([
      op("a.x.before"),
      { kind: "all", branches: [[op("b.x.one")], [op("b.x.two")], [op("b.x.three")]] },
      op("c.x.after"),
    ]);
    const at = layout(graph).boxes;
    const [first, second, third] = ["op:1", "op:2", "op:3"].map((id) => at.get(id)!);
    expect(new Set([first!.x, second!.x, third!.x]).size).toBe(1);
    // In member order, without overlapping.
    expect(second!.y - first!.y).toBeGreaterThanOrEqual(NODE_SIZE.op.height);
    expect(third!.y - second!.y).toBeGreaterThanOrEqual(NODE_SIZE.op.height);
    // Between what came before and after.
    expect(at.get("op:0")!.x).toBeLessThan(first!.x);
    expect(at.get("op:4")!.x).toBeGreaterThan(first!.x);
  });

  it("lays a cluster out around what it holds, under its label, between its neighbours", () => {
    const graph = outlineGraph([
      {
        kind: "repeat",
        body: [op("x.batch.open"), { kind: "all", branches: [[op("a.post.create")], [op("b.post.create")]] }],
      },
    ]);
    const at = layout(graph).boxes;
    const box = at.get("cluster:0")!;
    const [open, a, b] = ["op:1", "op:2", "op:3"].map((id) => at.get(id)!);
    // The lanes share a rank and stack apart, inside the cluster, under its label.
    expect(a!.x).toBe(b!.x);
    expect(b!.y - a!.y).toBeGreaterThanOrEqual(NODE_SIZE.op.height);
    expect(open!.x + NODE_SIZE.op.width).toBeLessThan(a!.x);
    for (const inner of [open!, a!, b!]) {
      expect(inner.y).toBeGreaterThanOrEqual(CLUSTER_HEADER);
      expect(inner.x + inner.width).toBeLessThanOrEqual(box.width);
      expect(inner.y + inner.height).toBeLessThanOrEqual(box.height);
    }
    expect(box.width).toBeGreaterThan(2 * NODE_SIZE.op.width);
    expect(at.get("start")!.x + NODE_SIZE.start.width).toBeLessThan(box.x);
    expect(box.x + box.width).toBeLessThan(at.get("end")!.x);
  });

  it("routes each edge of a loop holding a branch (the drift workflow's shape) from side to side, around the nodes", () => {
    expect(routeProblems(outlineGraph(DRIFT_SHAPE))).toEqual([]);
  });

  it("routes a fan-out's empty member, a branch beside a call and an empty loop around their nodes", () => {
    const graph = outlineGraph([
      op("a.x.before"),
      { kind: "all", branches: [[op("b.x.one"), op("b.x.two")], [op("b.x.three")], []] },
      { kind: "branch", cases: [[op("c.x.one")], []] },
      { kind: "repeat", body: [] },
      op("d.x.after"),
    ]);
    expect(routeProblems(graph)).toEqual([]);
  });

  it("runs straight through a loop holding one operation, from start to end", () => {
    const graph = outlineGraph([{ kind: "repeat", body: [op("x.item.get")] }]);
    const { routes } = layout(graph);
    expect(routeProblems(graph)).toEqual([]);
    // Into the loop, on inside it to the call, back to its right side and out: one height throughout.
    for (const id of ["start->cluster:0", "cluster:0->op:1", "op:1->cluster:0", "cluster:0->end"]) {
      const route = routes.get(id)!;
      expect(route, id).toHaveLength(2);
      expect(route[0]!.y, id).toBe(routes.get("start->cluster:0")![0]!.y);
    }
  });

  it("runs an empty loop's way across it below its label", () => {
    const graph = outlineGraph([{ kind: "repeat", body: [] }]);
    const { boxes, routes } = layout(graph);
    const box = boxes.get("cluster:0")!;
    const route = routes.get("cluster:0->cluster:0")!;
    expect(route).toEqual([
      { x: box.x, y: route[0]!.y },
      { x: box.x + box.width, y: route[0]!.y },
    ]);
    expect(route[0]!.y).toBeGreaterThan(box.y + CLUSTER_HEADER);
    expect(route[0]!.y).toBeLessThan(box.y + box.height);
    expect(routeProblems(graph)).toEqual([]);
  });

  it("refuses an edge between nodes in different boxes, naming it", () => {
    const graph = outlineGraph([{ kind: "repeat", body: [op("x.item.get")] }, op("x.item.done")]);
    graph.edges.push({ id: "op:1->op:2", source: "op:1", target: "op:2" });
    expect(() => layout(graph)).toThrow("layout: edge op:1->op:2 joins neither");
  });
});
