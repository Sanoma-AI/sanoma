import type { OpEntry, Span } from "sanoma/workflows/describe";
import { DEFAULT_SLEEP_NAME } from "sanoma/workflows/shared";
import type { CallStep, Graph, GraphEdge, GraphNode, Step, StepState } from "./types.ts";

/** A graph's two ends: an outline's are plain; a run's say how it started and how it ended. */
export interface Ends {
  start?: StepState;
  end: { label: string; state?: StepState; pending?: true };
}

const OUTLINE_ENDS: Ends = { end: { label: "end" } };

/** What a company operation's box has besides its label: its step's key, its operation, state and span. */
type OpBox = { key?: string | undefined } & Partial<
  Pick<Extract<GraphNode, { kind: "cluster" }>, "op" | "state" | "span">
>;

/**
 * The calls inside a company operation, from its entry's outline: its nodes without their spans,
 * which index the operation's file, not the workflow's source. None for any other operation, or one
 * whose outline could not be read.
 */
function callsIn(op: OpEntry | undefined): Step[] | undefined {
  const outline = op?.outline;
  if (!outline || !("nodes" in outline)) return undefined;
  return JSON.parse(JSON.stringify(outline.nodes, (key, value: unknown) => (key === "span" ? undefined : value)));
}

/** A call's node's own: its step's state (of its own kind), and its place in the source. */
const own = <S extends CallStep>(step: S): Pick<S, "state"> & { span?: Span } => ({
  ...(step.state && { state: step.state }),
  ...(step.span && { span: step.span }),
});

/**
 * Steps as a graph: a chain from start to end. A `ctx.all` is one lane per member between the
 * node before it and the node after; a branch splits at a diamond into one lane per case. A
 * computed `ctx.all`'s member, and a loop's body, is a chain in a cluster labelled with the label
 * the outline reads from its code ("for each of subscribers", "repeat while more"), each joined
 * from the cluster (its inside left) and back to it (its inside right). A `try` is its body's
 * chain beside a cluster labelled "on error" holding the handler's, both from the node before. An
 * empty member leads straight from the node before to the node after; a branch's empty case, the
 * way past it, is a lane marked "otherwise". A workflow's outline is drawn this way, and a run's
 * ledger once runGraph has made it into steps. A call's node has its step's `span`, and an
 * operation's or a sleep's its step's name when it is not the default (the operation's id,
 * `DEFAULT_SLEEP_NAME`). A company operation is a box (`cluster` with its `op`), labelled with its
 * step's name, holding the calls inside it as a chain: a run's step's `calls`, else those of its
 * entry in `ops` (the config's operations by id), the operation's outline.
 */
export function outlineGraph(
  outline: readonly Step[],
  { ends = OUTLINE_ENDS, ops }: { ends?: Ends; ops?: ReadonlyMap<string, OpEntry> } = {},
): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let count = 0;

  const join = (source: string, target: string) => edges.push({ id: `${source}->${target}`, source, target });
  /** Adds the node, drawn from each of `from`, and returns its id. */
  const add = (node: GraphNode, from: readonly string[]): string => {
    nodes.push(node);
    for (const source of from) join(source, node.id);
    return node.id;
  };
  const idOf = (kind: string, key: string | undefined) => key ?? `${kind}:${count++}`;

  /** Adds `steps` one after another from `from`, and returns the ids what follows is drawn from. */
  function chain(steps: readonly Step[], from: readonly string[], parent?: string): readonly string[] {
    const inside = parent === undefined ? {} : { parent };
    const lanes = (lists: readonly (readonly Step[])[], start: readonly string[]) => [
      ...new Set(lists.flatMap((lane) => chain(lane, start, parent))),
    ];
    // Its body runs from the box back to the box, so an edge to the box goes on inside it, and
    // one from it starts where the body ends. An empty body is one edge from the box to itself.
    const cluster = (label: string, body: readonly Step[], { key, ...box }: OpBox = {}) => {
      const id = add({ id: idOf("cluster", key), kind: "cluster", label, ...box, ...inside }, from);
      for (const tail of chain(body, [id], id)) join(tail, id);
      return [id];
    };
    for (const step of steps) {
      switch (step.kind) {
        case "op": {
          const calls = step.calls ?? callsIn(ops?.get(step.id));
          if (calls) {
            const name = step.name && step.name !== step.id ? { name: step.name } : {};
            from = cluster(step.name ?? step.id, calls, { key: step.key, op: { id: step.id, ...name }, ...own(step) });
            break;
          }
          from = [
            add(
              {
                id: idOf("op", step.key),
                kind: "op",
                label: step.id,
                ...(step.name && step.name !== step.id && { name: step.name }),
                ...(step.ops && { ops: step.ops }),
                ...inside,
                ...own(step),
              },
              from,
            ),
          ];
          break;
        }
        case "approval": {
          const label = step.title === undefined ? "approval" : `“${step.title}”`;
          from = [add({ id: idOf("approval", step.key), kind: "approval", label, ...inside, ...own(step) }, from)];
          break;
        }
        case "sleep": {
          const label = step.label ?? "sleep";
          const name = step.name && step.name !== DEFAULT_SLEEP_NAME ? { name: step.name } : {};
          from = [add({ id: idOf("sleep", step.key), kind: "sleep", label, ...name, ...inside, ...own(step) }, from)];
          break;
        }
        case "pending":
          from = [add({ id: step.key, kind: "pending", label: "not started", ...inside }, from)];
          break;
        case "all":
          if (step.branches.length) from = lanes(step.branches, from);
          break;
        case "each":
        case "repeat":
          from = cluster(step.label, step.body);
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
