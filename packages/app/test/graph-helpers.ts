import type { Box } from "../src/graph/layout.ts";
import type { GraphEdge, GraphNode, Step } from "../src/graph/types.ts";

// What the graph tests compare a graph by, and an outline they share.

/**
 * The drift workflow's shape: a loop whose body is an if/else, a call with many rows on one side
 * and the way past it on the other.
 */
export const DRIFT_SHAPE: Step[] = [
  {
    kind: "repeat",
    body: [
      {
        kind: "branch",
        cases: [
          [
            {
              kind: "try",
              body: [
                {
                  kind: "op",
                  id: "*.*.import",
                  ops: ["a.x.import", "a.y.import", "b.z.import", "b.w.import", "c.v.import"],
                },
              ],
              handler: [],
            },
          ],
          [],
        ],
      },
    ],
  },
];

/** Each edge as `source->target`. */
export const pairs = (edges: readonly GraphEdge[]) => edges.map((e) => `${e.source}->${e.target}`);

/**
 * Each node's box with its clusters' corners added in: where it is on the page, not in its
 * cluster. layout moves its routes onto the page itself, as it places each cluster; this walks the
 * boxes apart from that, so the route tests check layout's routes against the boxes React Flow
 * places rather than against layout's own arithmetic.
 */
export function absolute(nodes: readonly GraphNode[], boxes: ReadonlyMap<string, Box>): Map<string, Box> {
  const out = new Map<string, Box>();
  // A cluster comes before the nodes inside it.
  for (const node of nodes) {
    const box = boxes.get(node.id)!;
    const parent = node.parent === undefined ? { x: 0, y: 0 } : out.get(node.parent)!;
    out.set(node.id, { ...box, x: box.x + parent.x, y: box.y + parent.y });
  }
  return out;
}

/** Each node as its id and its tone in a run, `-` when it has none. */
export const summary = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${("state" in n && n.state?.tone) || "-"}`);

/** Each node as its id and label, and the cluster it is drawn in. */
export const labels = (nodes: readonly GraphNode[]) =>
  nodes.map((n) => `${n.id} ${n.label}${n.parent ? ` in ${n.parent}` : ""}`);

/** Each node as its id and its span in the source, as JSON: `null` when it has none. */
export const spans = (nodes: readonly GraphNode[]) => nodes.map((n) => `${n.id} ${JSON.stringify(n.span ?? null)}`);

/** Each node as its id and the text of its span up to the call's arguments: `-` when it has none. */
export const calls = (nodes: readonly GraphNode[], text: string) =>
  nodes.map((n) => `${n.id} ${n.span ? text.slice(...n.span).split("(")[0] : "-"}`);
