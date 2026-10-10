import { readFileSync } from "node:fs";
import { outlineWorkflow } from "@sanoma/workflows/describe";
import { describe, expect, it } from "vitest";
import announce from "../../workflows/test/fixtures/announce.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import { type GraphNode, nodeAt, type Step } from "../src/graph/types.ts";
import { calls, labels, pairs } from "./graph-helpers.ts";

// Hand-built outlines, in the shapes outlineWorkflow returns (packages/workflows/src/outline.ts).

const op = (id: string): Step => ({ kind: "op", id });

describe("outlineGraph", () => {
  it("draws a sequence as a chain from start to end, with no state", () => {
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
      "approval:1 “Review launch copy”",
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
    expect(nodes[1]).toEqual({ id: "op:0", kind: "op", label: "ghost.post.create" });
    expect(nodes.at(-1)).toEqual({ id: "end", kind: "end", label: "end" });
    expect(nodes.some((n) => "state" in n)).toBe(false);
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

  it("draws a try as its body beside a cluster labelled on error, both from the node before", () => {
    const { nodes, edges } = outlineGraph([
      op("x.item.get"),
      { kind: "try", body: [op("x.item.send")], handler: [op("x.item.log"), { kind: "sleep" }] },
      op("x.item.done"),
    ]);
    expect(labels(nodes)).toEqual([
      "start start",
      "op:0 x.item.get",
      "op:1 x.item.send",
      "cluster:2 on error",
      "op:3 x.item.log in cluster:2",
      "sleep:4 sleep in cluster:2",
      "op:5 x.item.done",
      "end end",
    ]);
    expect(pairs(edges)).toEqual([
      "start->op:0",
      "op:0->op:1",
      "op:0->cluster:2",
      "op:3->sleep:4",
      "op:1->op:5",
      "cluster:2->op:5",
      "op:5->end",
    ]);
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
      "approval:3 “Go?”",
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

  it("draws a branch's way past its cases as a lane of its own, marked otherwise", () => {
    const { nodes, edges } = outlineGraph([
      { kind: "branch", cases: [[{ kind: "approval", title: "Shout?" }], []] },
      op("b.x.after"),
    ]);
    expect(labels(nodes).slice(1, -1)).toEqual([
      "split:0 branch",
      "approval:1 “Shout?”",
      "skip:2 otherwise",
      "op:3 b.x.after",
    ]);
    expect(pairs(edges)).toEqual([
      "start->split:0",
      "split:0->approval:1",
      "split:0->skip:2",
      "approval:1->op:3",
      "skip:2->op:3",
      "op:3->end",
    ]);
  });

  it("draws a ctx.all inside a loop as lanes inside its cluster", () => {
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
  });

  it("gives each call's node its place in the workflow's file, as outlineWorkflow reads it", () => {
    const outline = outlineWorkflow(announce);
    if (!("file" in outline)) throw new Error(`announce was not outlined from its file: ${JSON.stringify(outline)}`);
    const text = readFileSync(outline.file, "utf8");
    expect(calls(outlineGraph(outline.nodes).nodes, text)).toEqual([
      "start -",
      "op:0 ctx.ghost.post.create",
      "op:1 ctx.resend.broadcast.create",
      "approval:2 ctx.approval",
      "sleep:3 ctx.sleep",
      "op:4 ctx.ghost.post.publish",
      "op:5 ctx.resend.broadcast.send",
      "op:6 ctx.bluesky.post.create",
      "end -",
    ]);
  });

  it("finds the node a click in the source is in: the innermost, the last of equals (a loop's latest pass), or none", () => {
    const nodes: GraphNode[] = [
      { id: "op:0", kind: "op", label: "a.b.outer", span: [0, 40] },
      { id: "op:1", kind: "op", label: "a.b.inner", span: [10, 20] },
      { id: "op:2", kind: "op", label: "a.b.inner", span: [10, 20] },
      { id: "sleep:3", kind: "sleep", label: "sleep", span: [50, 60] },
      { id: "end", kind: "end", label: "end" },
    ];
    const at = (offset: number) => nodeAt(nodes, offset)?.id;
    // A span's end is outside it.
    expect([at(5), at(10), at(15), at(19), at(20), at(55), at(40)]).toEqual([
      "op:0",
      "op:2",
      "op:2",
      "op:2",
      "op:0",
      "sleep:3",
      undefined,
    ]);
  });
});
