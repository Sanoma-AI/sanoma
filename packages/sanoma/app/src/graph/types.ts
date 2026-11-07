import type { ApprovalState, ErrorCode, RecordedDecision } from "@sanoma-ai/workflows";
import type { Span } from "@sanoma-ai/workflows/describe";
import type { Tone } from "../lib/tone.ts";

/*
 * A graph before layout: what outline-graph.ts builds, layout.ts places and
 * components/graph.tsx draws. No React here.
 */

/** How a step went in a run. An outline has none: it shows what a run may do, not what one did. */
export interface StepState {
  tone: Tone;
  /** The ledger record a click on the node shows. */
  recordId?: string;
}

/**
 * An operation call's: the policy's decision and how the call ended, once it is recorded. On a
 * workflow's outline, only what a scenario says of the operation, with no tone: nothing has run.
 */
export interface OpState extends Omit<StepState, "tone"> {
  tone?: Tone;
  decision?: RecordedDecision["kind"];
  errorCode?: ErrorCode;
  durationMs?: number;
  /** The policy's approval holding the call, as the run tells it. */
  approval?: ApprovalState;
  /**
   * What a scenario says of the operation, on a workflow's outline: a `Given` seeds it or makes
   * its next call fail, a `Then` expects a call to it, expects none, or expects the policy to
   * have denied it or held it.
   */
  scenario?: { seeded?: true; fails?: true; expected?: true; forbidden?: true; denied?: true; held?: true };
}

/** A workflow's approval, as the run tells it. */
export interface ApprovalStepState extends StepState {
  approval?: ApprovalState;
}

/**
 * What a graph is built from: a workflow's outline as `outlineWorkflow` reads it (an
 * `OutlineNode[]` is a `Step[]`, each call with its `span` in the source), or a run's ledger made
 * into the same shape, with each step's state and, where its record names an outline node that
 * is still its call, that node's `span`. `key` names a run's node, so it keeps its id from one poll
 * to the next.
 */
export type Step =
  /**
   * `ops`: for an id with a computed segment, the operations it can reach (the outline's `ops`).
   * `name`: the step's name, when the call gave one (an outline's) or a run recorded one.
   */
  | { kind: "op"; id: string; ops?: string[]; name?: string; key?: string; span?: Span; state?: OpState }
  | { kind: "approval"; title?: string; key?: string; span?: Span; state?: ApprovalStepState }
  /** `label`: a run's says until when. `name`: the step's name, as the outline or the run's record has it. */
  | { kind: "sleep"; name?: string; key?: string; label?: string; span?: Span; state?: StepState }
  /** A `ctx.all` member a running run has recorded nothing for yet. */
  | { kind: "pending"; key: string }
  | { kind: "all"; branches: Step[][] }
  /** A `ctx.all` over computed members, or a loop, with the label the outline reads from its code (`for each of items`). */
  | { kind: "each"; label: string; body: Step[] }
  | { kind: "repeat"; label: string; body: Step[] }
  | { kind: "branch"; cases: Step[][] }
  /** A `try`: the `handler` runs when the `body` fails. */
  | { kind: "try"; body: Step[]; handler: Step[] };

/** A call: a step drawn as one node, with a place in the source. */
export type CallStep = Extract<Step, { kind: "op" | "approval" | "sleep" }>;

interface Base {
  id: string;
  /** What the node says: an operation's id, an approval's title in quotes, a loop's label, an outcome. */
  label: string;
  /** The `cluster` node it is drawn inside, by id. */
  parent?: string;
  /** Where a call's node is in the workflow's source, when the outline says. */
  span?: Span;
}

export type GraphNode =
  | (Base & { kind: "start"; state?: StepState })
  /** `pending` until the run has ended; an outline's end is plain. */
  | (Base & { kind: "end"; state?: StepState; pending?: true })
  /**
   * `ops`: the operations an id with a computed segment can reach, drawn as rows under it.
   * `name`: the step's name, when it is not the operation's id, drawn above the id.
   */
  | (Base & { kind: "op"; ops?: string[]; name?: string; state?: OpState })
  | (Base & { kind: "approval"; state?: ApprovalStepState })
  /** `name`: the step's name, when it is not the default (`DEFAULT_SLEEP_NAME`), drawn above the clock. */
  | (Base & { kind: "sleep"; name?: string; state?: StepState })
  | (Base & { kind: "pending" })
  /** A box around a loop's body, a computed `ctx.all`'s member or a `try`'s handler, which `label` names. */
  | (Base & { kind: "cluster" })
  /** Where a branch splits into its cases. */
  | (Base & { kind: "split" })
  /** A branch's way past its cases, when it has one: an `if` without `else`, say. */
  | (Base & { kind: "skip" });

export type GraphNodeKind = GraphNode["kind"];

/** True for a node a page can select: one with a place in the source, or a ledger record. */
export const isSelectable = (node: GraphNode): boolean => !!node.span || ("state" in node && !!node.state?.recordId);

/**
 * An edge between two nodes in one box (the page, or a `cluster`), or between a cluster and what
 * it holds: one from the cluster to a node in it leaves its inside left, one from a node in it to
 * the cluster reaches its inside right, and one from the cluster to itself crosses its empty
 * inside. layout tells these apart by the nodes' `parent`.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The node a click at `offset` in the source is in: of the nodes with a span that holds it (its
 * end exclusive, as `highlightedLines` reads it), the one whose span is smallest, so a call made
 * in another's arguments wins over the outer call. The last of equals: a run's steps of one call
 * (a loop's passes) share its span, and the latest is the one the run is on.
 */
export function nodeAt(nodes: readonly GraphNode[], offset: number): GraphNode | undefined {
  let found: GraphNode | undefined;
  let size = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (!node.span) continue;
    const [start, end] = node.span;
    if (start <= offset && offset < end && end - start <= size) {
      found = node;
      size = end - start;
    }
  }
  return found;
}

/** True for what a run has not reached yet: drawn dashed, as are the edges into and out of it. */
export const isPending = (node: GraphNode): boolean =>
  node.kind === "pending" || (node.kind === "end" && !!node.pending);
