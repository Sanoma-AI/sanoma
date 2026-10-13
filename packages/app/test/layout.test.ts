import { describe, expect, it } from "vitest";
import { type Box, CLUSTER_HEADER, layout, NODE_SIZE, nodeSize, type Point } from "../src/graph/layout.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import type { Graph, Step } from "../src/graph/types.ts";
import { LIST_HEADER, MAX_ROWS, ROW_HEIGHT } from "../src/graph/wildcard.ts";
import { absolute } from "./graph-helpers.ts";

const op = (id: string) => ({ kind: "op", id }) as const;

const text = ({ x, y }: Point) => `(${x}, ${y})`;

/** True when the segment from `a` to `b` runs through the inside of `box`, not along or outside its border. */
function crosses(a: Point, b: Point, box: Box): boolean {
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 < box.x + box.width && x2 > box.x && y1 < box.y + box.height && y2 > box.y;
}

/**
 * What is wrong with each edge's route, as text: none when it starts on its source's box (the
 * right side's middle, or the left side's for a cluster's inside), ends on its target's (the left
 * side's middle, or the right side's for a cluster's inside), and runs in straight lines across
 * and down through no other node's box.
 */
function routeProblems(graph: Graph): string[] {
  const { boxes, routes } = layout(graph);
  const at = absolute(graph.nodes, boxes);
  const parentOf = new Map(graph.nodes.map((n) => [n.id, n.parent]));
  const around = (id: string): string[] => {
    const parent = parentOf.get(id);
    return parent === undefined ? [id] : [id, ...around(parent)];
  };
  return graph.edges.flatMap((edge) => {
    const route = routes.get(edge.id);
    if (!route) return [`${edge.id} has no route`];
    const [from, to] = [at.get(edge.source)!, at.get(edge.target)!];
    const start = { x: edge.sourceHandle ? from.x : from.x + from.width, y: from.y + from.height / 2 };
    const end = { x: edge.targetHandle ? to.x + to.width : to.x, y: to.y + to.height / 2 };
    const problems: string[] = [];
    if (text(route[0]!) !== text(start)) problems.push(`${edge.id} starts at ${text(route[0]!)}, not ${text(start)}`);
    if (text(route.at(-1)!) !== text(end)) problems.push(`${edge.id} ends at ${text(route.at(-1)!)}, not ${text(end)}`);
    const own = new Set([...around(edge.source), ...around(edge.target)]);
    for (const [i, a] of route.slice(0, -1).entries()) {
      const b = route[i + 1]!;
      if (a.x !== b.x && a.y !== b.y) problems.push(`${edge.id} runs aslant from ${text(a)} to ${text(b)}`);
      for (const node of graph.nodes) {
        if (!own.has(node.id) && crosses(a, b, at.get(node.id)!)) problems.push(`${edge.id} runs behind ${node.id}`);
      }
    }
    return problems;
  });
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

  it("routes each edge of a loop holding a branch from its source's handle to its target's, around the nodes", () => {
    // The drift workflow's shape: a loop whose body is an if/else, a call with many rows on one side.
    const ops = ["a.x.import", "a.y.import", "b.z.import", "b.w.import", "c.v.import"];
    const branch: Step = {
      kind: "branch",
      cases: [[{ kind: "try", body: [{ kind: "op", id: "*.*.import", ops }], handler: [] }], []],
    };
    const graph = outlineGraph([{ kind: "repeat", body: [branch] }]);
    // The otherwise edge leaves the diamond, not the call beside it.
    expect(graph.edges.find((e) => e.target === "skip:3")!.source).toBe("split:1");
    expect(routeProblems(graph)).toEqual([]);
    // The cluster's border: where the edge to it ends, the edge inside it goes on.
    const { routes } = layout(graph);
    expect(routes.get("cluster:0->split:1")![0]).toEqual(routes.get("start->cluster:0")!.at(-1));
    expect(routes.get("op:2->cluster:0")!.at(-1)).toEqual(routes.get("cluster:0->end")![0]);
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
});
