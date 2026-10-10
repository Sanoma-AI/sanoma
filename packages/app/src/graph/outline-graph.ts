import type { Span } from "@sanoma/workflows/describe";
import type { CallStep, Graph, GraphEdge, GraphNode, Step, StepState } from "./types.ts";

/** A graph's two ends: an outline's are plain; a run's say how it started and how it ended. */
export interface Ends {
  start?: StepState;
  end: { label: string; state?: StepState; pending?: true };
}

const OUTLINE_ENDS: Ends = { end: { label: "end" } };

/**
 * Steps as a graph: a chain from start to end. A `ctx.all` is one lane per member between the
 * node before it and the node after; a branch splits at a diamond into one lane per case. A
 * computed `ctx.all`'s member is a chain in a cluster labelled "for each", a loop's body one in a
 * cluster labelled "repeats". A `try` is its body's chain beside a cluster labelled "on error"
 * holding the handler's, both from the node before. An empty member leads straight from the node
 * before to the node after; a branch's empty case, the way past it, is a lane marked "otherwise". A workflow's
 * outline is drawn this way, and a run's ledger once runGraph has made it into steps. A call's
 * node has the `spans` that `where` gives for its step: by default the step's own `span`.
 */
export function outlineGraph(
  outline: readonly Step[],
  ends: Ends = OUTLINE_ENDS,
  where: (step: CallStep) => Span[] | undefined = (step) => step.span && [step.span],
): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let count = 0;

  /** Adds the node, drawn from each of `from`, and returns its id. */
  const add = (node: GraphNode, from: readonly string[]): string => {
    nodes.push(node);
    for (const source of from) edges.push({ id: `${source}->${node.id}`, source, target: node.id });
    return node.id;
  };
  const idOf = (kind: string, key: string | undefined) => key ?? `${kind}:${count++}`;
  /** A call's node's own: its step's state, and its place in the source. */
  const own = (step: CallStep) => {
    const spans = where(step);
    return { ...(step.state && { state: step.state }), ...(spans && { spans }) };
  };

  /** Adds `steps` one after another from `from`, and returns the ids what follows is drawn from. */
  function chain(steps: readonly Step[], from: readonly string[], parent?: string): readonly string[] {
    const inside = parent === undefined ? {} : { parent };
    const lanes = (lists: readonly (readonly Step[])[], start: readonly string[]) => [
      ...new Set(lists.flatMap((lane) => chain(lane, start, parent))),
    ];
    const cluster = (label: string, body: readonly Step[]) => {
      const id = add({ id: idOf("cluster", undefined), kind: "cluster", label, ...inside }, from);
      chain(body, [], id);
      return [id];
    };
    for (const step of steps) {
      switch (step.kind) {
        case "op":
          from = [add({ id: idOf("op", step.key), kind: "op", label: step.id, ...inside, ...own(step) }, from)];
          break;
        case "approval": {
          const label = step.title === undefined ? "approval" : `“${step.title}”`;
          from = [add({ id: idOf("approval", step.key), kind: "approval", label, ...inside, ...own(step) }, from)];
          break;
        }
        case "sleep": {
          const label = step.label ?? "sleep";
          from = [add({ id: idOf("sleep", step.key), kind: "sleep", label, ...inside, ...own(step) }, from)];
          break;
        }
        case "pending":
          from = [add({ id: step.key, kind: "pending", label: "not started", ...inside }, from)];
          break;
        case "all":
          if (step.branches.length) from = lanes(step.branches, from);
          break;
        case "each":
          from = cluster("for each", step.body);
          break;
        case "repeat":
          from = cluster("repeats", step.body);
          break;
        case "try": {
          const after = chain(step.body, from, parent);
          from = step.handler.length ? [...after, ...cluster("on error", step.handler)] : after;
          break;
        }
        case "branch": {
          const split = add({ id: idOf("split", undefined), kind: "split", label: "branch", ...inside }, from);
          // The way past the cases gets a node of its own: an edge alone would run straight from
          // the split to what follows, behind the case drawn level with them.
          const past = (lane: readonly Step[]) =>
            lane.length
              ? chain(lane, [split], parent)
              : [add({ id: idOf("skip", undefined), kind: "skip", label: "otherwise", ...inside }, [split])];
          from = [...new Set(step.cases.flatMap(past))];
          break;
        }
      }
    }
    return from;
  }

  add({ id: "start", kind: "start", label: "start", ...(ends.start && { state: ends.start }) }, []);
  const tails = chain(outline, ["start"]);
  add({ id: "end", kind: "end", ...ends.end }, tails);
  return { nodes, edges };
}
