import { describe, expect, it } from "vitest";
import { CLUSTER_HEADER, layout, NODE_SIZE } from "../src/graph/layout.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";

const op = (id: string) => ({ kind: "op", id }) as const;

describe("layout", () => {
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
