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
  op("ghost.post.publish"),
  op("bluesky.post.create"),
]);

const steps: ScenarioEntry["steps"] = [
  { text: 'a post titled "Old news" exists', kind: "given", op: "ghost.post.create" },
  { text: "ghost.post.publish fails once", kind: "given", op: "ghost.post.publish" },
  { text: "announce runs", kind: "when" },
  { text: '"Review launch copy" is approved by marketing-lead', kind: "when" },
  { text: 'a post titled "Acme Pro" is created', kind: "then", op: "ghost.post.create" },
  { text: "bluesky.post.create was not called", kind: "then", op: "bluesky.post.create" },
  { text: "the run succeeds", kind: "then" },
];

/** Each node as its id, and its note and tone when it has a note: `-` when it has none. */
const notes = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => {
    const state = n.kind === "op" ? n.state : undefined;
    return `${n.id} ${state?.note ? `${state.note} (${state.tone})` : "-"}`;
  });

describe("annotateGraph", () => {
  it("notes what the scenario seeds and expects on the operations it names, and nothing elsewhere", () => {
    const marked = annotateGraph(graph, { steps });
    expect(notes(marked.nodes)).toEqual([
      "start -",
      "op:0 seeded · expected (waiting)",
      "approval:1 -",
      "op:2 seeded (idle)",
      "op:3 expected (waiting)",
      "end -",
    ]);
    // The other nodes, and the edges, are the outline's own.
    expect(marked.edges).toBe(graph.edges);
    expect(marked.nodes[1]).toEqual({
      id: "op:0",
      kind: "op",
      label: "ghost.post.create",
      state: { tone: "waiting", note: "seeded · expected" },
    });
    expect(marked.nodes[2]).toBe(graph.nodes[2]);
    // The outline itself is left as it was.
    expect(notes(graph.nodes).every((n) => n.endsWith(" -"))).toBe(true);
  });

  it("returns the graph as it is for a scenario that names no operation", () => {
    expect(annotateGraph(graph, { steps: [{ text: "announce runs", kind: "when" }] })).toBe(graph);
  });
});
