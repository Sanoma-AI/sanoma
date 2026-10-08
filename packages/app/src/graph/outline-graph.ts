import type { OutlineNode } from "@sanoma/workflows/lint";
import type { GraphEdge, GraphNode, RunGraph } from "./run-graph.ts";

/**
 * A workflow's outline (`outlineWorkflow`, read from its `run`'s source) as a graph of the same
 * nodes and edges as a run's, so the same layout and component draw it: a chain from start to
 * end, with no tone, record or run state. A literal `ctx.all` is one lane per member between the
 * node before it and the node after; a dynamic one (`ids.map(…)`) is its one member in a cluster
 * labelled "for each". A loop's body is a chain in a cluster labelled "repeats". A branch splits
 * at a diamond into one lane per case that makes calls.
 */
export function outlineGraph(outline: readonly OutlineNode[]): RunGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let seq = 0;

  /** Adds the node, drawn from each of `from`, and returns its id. */
  const add = (node: GraphNode, from: readonly string[]): string => {
    nodes.push(node);
    for (const source of from) {
      const id = `${source}->${node.id}`;
      if (!edges.some((e) => e.id === id)) edges.push({ id, source, target: node.id, active: false, pending: false });
    }
    return node.id;
  };
  const base = (kind: GraphNode["kind"], label: string, parent: string | undefined) => ({
    id: `${kind}:${seq}`,
    label,
    seq: seq++,
    ...(parent === undefined ? {} : { parent }),
  });
  /** A cluster holding `body`, drawn from `from`. */
  const cluster = (label: string, body: readonly OutlineNode[], from: readonly string[], parent?: string) => {
    const id = add({ ...base("cluster", label, parent), kind: "cluster" }, from);
    chain(body, [], id);
    return id;
  };

  /** Adds `steps` one after another from `from`, and returns the ids what follows is drawn from. */
  function chain(steps: readonly OutlineNode[], from: readonly string[], parent?: string): readonly string[] {
    for (const step of steps) {
      switch (step.kind) {
        case "op":
          from = [add({ ...base("op", step.id, parent), kind: "op", op: step.id }, from)];
          break;
        case "approval":
          from = [
            add(
              {
                ...base("approval", step.title ?? "approval", parent),
                kind: "approval",
                ...(step.title === undefined ? {} : { title: step.title }),
              },
              from,
            ),
          ];
          break;
        case "sleep":
          from = [add({ ...base("sleep", "sleep", parent), kind: "sleep" }, from)];
          break;
        case "all":
          if (step.dynamic) from = [cluster("for each", step.branches[0] ?? [], from, parent)];
          // An empty lane leads straight from the node before to the node after.
          else if (step.branches.length) from = unique(step.branches.flatMap((b) => chain(b, from, parent)));
          break;
        case "repeat":
          from = [cluster("repeats", step.body, from, parent)];
          break;
        case "branch": {
          const split = [add({ ...base("split", "branch", parent), kind: "split" }, from)];
          from = unique(step.cases.flatMap((c) => chain(c, split, parent)));
          break;
        }
      }
    }
    return from;
  }

  add({ id: "start", kind: "start", label: "start", seq: -1 }, []);
  const tails = chain(outline, ["start"]);
  add({ id: "end", kind: "end", label: "end", seq }, tails);
  return { nodes, edges };
}

const unique = (ids: readonly string[]) => [...new Set(ids)];
