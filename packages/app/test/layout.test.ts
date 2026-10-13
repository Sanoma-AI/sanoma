import { describe, expect, it } from "vitest";
import { CLUSTER_HEADER, layout, NAME_HEIGHT, NODE_SIZE, nodeSize } from "../src/graph/layout.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import { LIST_HEADER, MAX_ROWS, ROW_HEIGHT } from "../src/graph/wildcard.ts";

const op = (id: string) => ({ kind: "op", id }) as const;

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
    expect(layout(graph).get(tall.id)!.height).toBe(nodeSize(tall).height);
    // Past MAX_ROWS the list collapses, so the node stops growing.
    const many = Array.from({ length: 20 }, (_, i) => `v.r${i}.read`);
    expect(nodeSize({ id: "x", kind: "op", label: "*.*.read", ops: many }).height).toBe(
      NODE_SIZE.op.height + LIST_HEADER + MAX_ROWS * ROW_HEIGHT,
    );
  });

  it("makes an operation with a name taller by the line its id moves to", () => {
    const named = { id: "x", kind: "op", label: "a.x.read", name: "Read it" } as const;
    expect(nodeSize(named)).toEqual({ width: NODE_SIZE.op.width, height: NODE_SIZE.op.height + NAME_HEIGHT });
    expect(nodeSize({ ...named, label: "*.*.read", ops: ["a.x.read"] }).height).toBe(
      NODE_SIZE.op.height + NAME_HEIGHT + LIST_HEADER + ROW_HEIGHT,
    );
  });

  it("lays a graph out left to right", () => {
    const graph = outlineGraph([op("a.x.one")]);
    const at = layout(graph);
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
    const at = layout(graph);
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
    const at = layout(graph);
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
});
