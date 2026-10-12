import { describe, expect, it } from "vitest";
import type { ScenarioEntry } from "../src/api.ts";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import { annotateGraph } from "../src/graph/scenario-graph.ts";
import type { GraphNode, Step } from "../src/graph/types.ts";

// A hand-built outline, in the shape outlineWorkflow returns, marked by a scenario's steps.

const op = (id: string): Step => ({ kind: "op", id });

const graph = outlineGraph([
  op("ghost.post.create"),
  { kind: "approval", title: "Review launch copy" },
  // A computed segment, as the outline shows `ctx.ghost[kind].publish`.
  op("ghost.*.publish"),
  op("bluesky.post.create"),
  op("resend.broadcast.send"),
  op("stripe.product.import"),
  op("github.repository.import"),
]);

const steps: ScenarioEntry["steps"] = [
  { text: 'a post titled "Old news" exists', kind: "given", op: "ghost.post.create" },
  { text: "ghost.post.publish fails once", kind: "given", op: "ghost.post.publish", fault: true },
  { text: "announce runs", kind: "when" },
  { text: '"Review launch copy" is approved by marketing-lead', kind: "when" },
  { text: 'a post titled "Acme Pro" is created', kind: "then", op: "ghost.post.create", called: true },
  { text: "bluesky.post.create was not called", kind: "then", op: "bluesky.post.create", called: false },
  { text: "stripe.product.import was held for finance", kind: "then", op: "stripe.product.import", decision: "held" },
  { text: "github.repository.import was denied", kind: "then", op: "github.repository.import", decision: "denied" },
  { text: "the run succeeds", kind: "then" },
];

/** Each node as its id, and what the scenario says of it: `-` when nothing. */
const marks = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => {
    const said = n.kind === "op" ? n.state?.scenario : undefined;
    return `${n.id} ${said ? Object.keys(said).join(" ") : "-"}`;
  });

describe("annotateGraph", () => {
  it("marks what the scenario seeds, fails, expects, forbids, denies and holds on the operations it names, and nothing elsewhere", () => {
    const marked = annotateGraph(graph, { steps });
    expect(marks(marked.nodes)).toEqual([
      "start -",
      "op:0 seeded expected",
      "approval:1 -",
      // A fault is no seed.
      "op:2 fails",
      "op:3 forbidden",
      "op:4 -",
      // A policy outcome is neither a call expected nor one forbidden.
      "op:5 held",
      "op:6 denied",
      "end -",
    ]);
    // The other nodes, and the edges, are the outline's own.
    expect(marked.edges).toBe(graph.edges);
    // No tone: nothing has run.
    expect(marked.nodes[1]).toEqual({
      id: "op:0",
      kind: "op",
      label: "ghost.post.create",
      state: { scenario: { seeded: true, expected: true } },
    });
    expect(marked.nodes[2]).toBe(graph.nodes[2]);
    expect(marked.nodes[5]).toBe(graph.nodes[5]);
    expect(marked.nodes[8]).toBe(graph.nodes[8]);
    // The outline itself is left as it was.
    expect(marks(graph.nodes).every((n) => n.endsWith(" -"))).toBe(true);
  });

  it("returns the graph as it is for a scenario that names no operation", () => {
    expect(annotateGraph(graph, { steps: [{ text: "announce runs", kind: "when" }] })).toBe(graph);
  });
});
