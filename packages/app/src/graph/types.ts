import type { ApprovalState, ErrorCode, RecordedDecision } from "@sanoma/workflows";
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

/** An operation call's: the policy's decision and how the call ended, once it is recorded. */
export interface OpState extends StepState {
  decision?: RecordedDecision["kind"];
  errorCode?: ErrorCode;
  durationMs?: number;
  /** The policy's approval holding the call, as the run tells it. */
  approval?: ApprovalState;
}

/** A workflow's approval, as the run tells it. */
export interface ApprovalStepState extends StepState {
  approval?: ApprovalState;
}

/**
 * What a graph is built from: a workflow's outline as `outlineWorkflow` reads it (an
 * `OutlineNode[]` is a `Step[]`), or a run's ledger made into the same shape, with each step's
 * state. `key` names a run's node, so it keeps its id from one poll to the next.
 */
export type Step =
  | { kind: "op"; id: string; key?: string; state?: OpState }
  | { kind: "approval"; title?: string; key?: string; state?: ApprovalStepState }
  | { kind: "sleep"; key?: string; label?: string; state?: StepState }
  /** A `ctx.all` member a running run has recorded nothing for yet. */
  | { kind: "pending"; key: string }
  | { kind: "all"; branches: Step[][] }
  | { kind: "each"; body: Step[] }
  | { kind: "repeat"; body: Step[] }
  | { kind: "branch"; cases: Step[][] };

interface Base {
  id: string;
  /** What the node says: an operation's id, an approval's title in quotes, an outcome. */
  label: string;
  /** The `cluster` node it is drawn inside, by id. */
  parent?: string;
}

export type GraphNode =
  | (Base & { kind: "start"; state?: StepState })
  /** `pending` until the run has ended; an outline's end is plain. */
  | (Base & { kind: "end"; state?: StepState; pending?: true })
  | (Base & { kind: "op"; state?: OpState })
  | (Base & { kind: "approval"; state?: ApprovalStepState })
  | (Base & { kind: "sleep"; state?: StepState })
  | (Base & { kind: "pending" })
  /** A box around a loop's body or a computed `ctx.all`'s member, which `label` names. */
  | (Base & { kind: "cluster" })
  /** Where a branch splits into its cases. */
  | (Base & { kind: "split" });

export type GraphNodeKind = GraphNode["kind"];

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** True for what a run has not reached yet: drawn dashed, as are the edges into and out of it. */
export const isPending = (node: GraphNode): boolean =>
  node.kind === "pending" || (node.kind === "end" && !!node.pending);
