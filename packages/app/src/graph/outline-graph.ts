import type { Graph, GraphEdge, GraphNode, Step, StepState } from "./types.ts";

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
 * cluster labelled "repeats". An empty lane leads straight from the node before to the node
 * after. A workflow's outline is drawn this way, and a run's ledger once runGraph has made it
 * into steps.
 */
export function outlineGraph(outline: readonly Step[], ends: Ends = OUTLINE_ENDS): Graph {
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
          from = [add({ id: idOf("op", step.key), kind: "op", label: step.id, ...inside, ...stateOf(step) }, from)];
          break;
        case "approval": {
          const label = step.title === undefined ? "approval" : `“${step.title}”`;
          from = [add({ id: idOf("approval", step.key), kind: "approval", label, ...inside, ...stateOf(step) }, from)];
          break;
        }
        case "sleep":
          from = [
            add(
              { id: idOf("sleep", step.key), kind: "sleep", label: step.label ?? "sleep", ...inside, ...stateOf(step) },
              from,
            ),
          ];
          break;
        case "pending":
          from = [add({ id: step.key, kind: "pending", label: "pending", ...inside }, from)];
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
        case "branch": {
          const split = add({ id: idOf("split", undefined), kind: "split", label: "branch", ...inside }, from);
          from = lanes(step.cases, [split]);
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

const stateOf = <S>(step: { state?: S }) => (step.state === undefined ? {} : { state: step.state });
