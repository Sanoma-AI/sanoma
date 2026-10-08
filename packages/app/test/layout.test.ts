import { describe, expect, it } from "vitest";
import { layout, NODE_SIZE } from "../src/graph/layout.ts";
import type { GraphEdge, GraphNode } from "../src/graph/run-graph.ts";

const op = (id: string, seq: number, index?: number): GraphNode => ({
  id,
  kind: "op",
  label: id,
  op: id,
  tone: "ok",
  seq,
  ...(index === undefined ? {} : { group: { id: "all:0", index, size: 3 } }),
});
const edge = (source: string, target: string): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  active: false,
  pending: false,
});

describe("layout", () => {
  it("lays a run out left to right", () => {
    const nodes: GraphNode[] = [
      { id: "start", kind: "start", label: "start", tone: "ok", seq: 0 },
      op("op:1", 1),
      { id: "end", kind: "end", label: "pending", state: "pending", tone: "off", seq: 2 },
    ];
    const at = layout(nodes, [edge("start", "op:1"), edge("op:1", "end")]);
    const xs = nodes.map((n) => at.get(n.id)!.x);
    expect(xs[0]! + NODE_SIZE.start.width).toBeLessThan(xs[1]!);
    expect(xs[1]! + NODE_SIZE.op.width).toBeLessThan(xs[2]!);
  });

  it("puts a fan-out's branches on one rank, one above another", () => {
    const branches = [op("op:2", 2, 0), op("op:3", 3, 1), op("op:4", 4, 2)];
    const nodes = [op("op:1", 1), ...branches, op("op:5", 5)];
    const edges = branches.flatMap((b) => [edge("op:1", b.id), edge(b.id, "op:5")]);
    const at = layout(nodes, edges);

    const placed = branches.map((b) => at.get(b.id)!);
    expect(new Set(placed.map((p) => p.x)).size).toBe(1);
    const ys = placed.map((p) => p.y).toSorted((a, b) => a - b);
    expect(new Set(ys).size).toBe(3);
    // Stacked without overlapping.
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(NODE_SIZE.op.height);
    // Between what came before and after.
    expect(at.get("op:1")!.x).toBeLessThan(placed[0]!.x);
    expect(at.get("op:5")!.x).toBeGreaterThan(placed[0]!.x);
  });
});
