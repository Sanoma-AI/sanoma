import type { OutlineNode } from "@sanoma/workflows/describe";
import { describe, expect, it } from "vitest";
import { CLUSTER_HEADER, layout, NODE_SIZE } from "../src/graph/layout.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import type { GraphNode } from "../src/graph/run-graph.ts";

// Hand-built outlines, in the shapes outlineWorkflow returns (packages/workflows/src/outline.ts).

const op = (id: string): OutlineNode => ({ kind: "op", id });

const labels = (nodes: GraphNode[]) => nodes.map((n) => `${n.id} ${n.label}${n.parent ? ` in ${n.parent}` : ""}`);
const pairs = (edges: { source: string; target: string }[]) => edges.map((e) => `${e.source}->${e.target}`);

describe("outlineGraph", () => {
  it("draws a sequence as a chain from start to end, with no tone or record", () => {
    const { nodes, edges } = outlineGraph([
      op("ghost.post.create"),
      { kind: "approval", title: "Review launch copy" },
      { kind: "approval" },
      { kind: "sleep" },
      op("*.post.create"),
    ]);
    expect(labels(nodes)).toEqual([
      "start start",
      "op:0 ghost.post.create",
      "approval:1 Review launch copy",
      "approval:2 approval",
      "sleep:3 sleep",
      "op:4 *.post.create",
      "end end",
    ]);
    expect(pairs(edges)).toEqual([
      "start->op:0",
      "op:0->approval:1",
      "approval:1->approval:2",
      "approval:2->sleep:3",
      "sleep:3->op:4",
      "op:4->end",
    ]);
    expect(nodes[1]).toEqual({ id: "op:0", kind: "op", label: "ghost.post.create", op: "ghost.post.create", seq: 0 });
    expect(nodes[2]).toMatchObject({ kind: "approval", title: "Review launch copy" });
    expect(nodes[3]).not.toHaveProperty("title");
    expect(nodes.some((n) => n.tone !== undefined || n.recordId !== undefined)).toBe(false);
    expect(edges.some((e) => e.active || e.pending)).toBe(false);
  });

  it("draws a literal ctx.all as one lane per member, from the node before to the node after", () => {
    const { nodes, edges } = outlineGraph([
      op("ghost.post.create"),
      { kind: "all", branches: [[op("a.post.create"), op("a.post.pin")], [op("b.post.create")], []] },
      op("c.mail.send"),
    ]);
    expect(labels(nodes).slice(1, -1)).toEqual([
      "op:0 ghost.post.create",
      "op:1 a.post.create",
      "op:2 a.post.pin",
      "op:3 b.post.create",
      "op:4 c.mail.send",
    ]);
    // The empty member leads straight on.
    expect(pairs(edges)).toEqual([
      "start->op:0",
      "op:0->op:1",
      "op:1->op:2",
      "op:0->op:3",
      "op:2->op:4",
      "op:3->op:4",
      "op:0->op:4",
      "op:4->end",
    ]);
  });

  it("draws a ctx.all over computed members as its one member in a cluster labelled for each", () => {
    const { nodes, edges } = outlineGraph([
      { kind: "each", body: [op("forum.comments.list"), op("forum.comments.hide")] },
      { kind: "each", body: [] },
    ]);
    expect(labels(nodes)).toEqual([
      "start start",
      "cluster:0 for each",
      "op:1 forum.comments.list in cluster:0",
      "op:2 forum.comments.hide in cluster:0",
      "cluster:3 for each",
      "end end",
    ]);
    expect(pairs(edges)).toEqual(["start->cluster:0", "op:1->op:2", "cluster:0->cluster:3", "cluster:3->end"]);
  });

  it("draws a loop's body as a chain in a cluster labelled repeats", () => {
    const { nodes, edges } = outlineGraph([
      { kind: "repeat", body: [op("x.item.get"), { kind: "sleep" }] },
      op("x.item.done"),
    ]);
    expect(labels(nodes)).toEqual([
      "start start",
      "cluster:0 repeats",
      "op:1 x.item.get in cluster:0",
      "sleep:2 sleep in cluster:0",
      "op:3 x.item.done",
      "end end",
    ]);
    expect(pairs(edges)).toEqual(["start->cluster:0", "op:1->sleep:2", "cluster:0->op:3", "op:3->end"]);
  });

  it("draws a branch as a split into one lane per case, joined after it", () => {
    const { nodes, edges } = outlineGraph([
      { kind: "branch", cases: [[op("a.x.one"), op("a.x.two")], [{ kind: "approval", title: "Go?" }]] },
      op("b.x.after"),
    ]);
    expect(labels(nodes).slice(1, -1)).toEqual([
      "split:0 branch",
      "op:1 a.x.one",
      "op:2 a.x.two",
      "approval:3 Go?",
      "op:4 b.x.after",
    ]);
    expect(pairs(edges)).toEqual([
      "start->split:0",
      "split:0->op:1",
      "op:1->op:2",
      "split:0->approval:3",
      "op:2->op:4",
      "approval:3->op:4",
      "op:4->end",
    ]);
  });

  it("draws a ctx.all inside a loop as lanes inside its cluster, and lays the cluster out around them", () => {
    const { nodes, edges } = outlineGraph([
      {
        kind: "repeat",
        body: [op("x.batch.open"), { kind: "all", branches: [[op("a.post.create")], [op("b.post.create")]] }],
      },
    ]);
    expect(labels(nodes)).toEqual([
      "start start",
      "cluster:0 repeats",
      "op:1 x.batch.open in cluster:0",
      "op:2 a.post.create in cluster:0",
      "op:3 b.post.create in cluster:0",
      "end end",
    ]);
    expect(pairs(edges)).toEqual(["start->cluster:0", "op:1->op:2", "op:1->op:3", "cluster:0->end"]);

    const at = layout(nodes, edges);
    const box = at.get("cluster:0")!;
    const [open, a, b] = ["op:1", "op:2", "op:3"].map((id) => at.get(id)!);
    // The lanes share a rank and stack apart, inside the cluster, under its label.
    expect(a!.x).toBe(b!.x);
    expect(Math.abs(a!.y - b!.y)).toBeGreaterThanOrEqual(NODE_SIZE.op.height);
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
