import type { ApprovalState, Effect, ErrorCode, RecordedDecision, RunStatus, RunSummary } from "@sanoma/workflows";
import { approverLabel, isEnded } from "@sanoma/workflows/shared";
import type { GraphRecord, LedgerGroup } from "../api.ts";
import { APPROVAL_TONE, RUN_TONE, type Tone } from "../lib/tone.ts";

/**
 * A run as a graph, built from its ledger: where it started, each operation call, sleep and
 * approval the workflow asked for, and how it ended. No React here: the page lays it out and
 * draws it (components/run-graph.tsx).
 */

/** An approval's state as the ledger tells it. */
export type HoldState = ApprovalState["status"];

/** An approval the policy asked for to let an operation call through. It belongs to the call's node. */
export interface Hold {
  approval: string;
  title: string;
  approver: string;
  state: HoldState;
  /** How many messages it ignored (not from the approver, or not a decision). */
  refused: number;
}

interface Base {
  id: string;
  label: string;
  tone: Tone;
  /** Orders the nodes: the seq of the record the node stands for. */
  seq: number;
  /** The ledger record to show when the node is clicked. */
  recordId?: string;
  group?: LedgerGroup;
}

export type GraphNode =
  | (Base & { kind: "start" })
  | (Base & {
      kind: "op";
      op: string;
      /** Unknown until the call is recorded, while the policy's approval is pending. */
      effect?: Effect;
      decision?: RecordedDecision["kind"];
      errorCode?: ErrorCode | undefined;
      durationMs?: number;
      hold?: Hold;
    })
  | (Base & { kind: "sleep"; until: number })
  | (Base & { kind: "approval"; approval: string; title: string; approver: string; state: HoldState; refused: number })
  | (Base & { kind: "end"; state: RunStatus | "pending"; errorCode?: ErrorCode | undefined });

export type GraphNodeKind = GraphNode["kind"];

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** The target is an operation in flight: draw the edge moving. */
  active: boolean;
  /** The target is the end the run has not reached yet. */
  pending: boolean;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type OpNode = Extract<GraphNode, { kind: "op" }>;
type ApprovalNode = Extract<GraphNode, { kind: "approval" }>;

const sleepLabel = (until: number) => `sleep until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The run's graph. Nodes come in `seq` order and edges follow it, except that the records of
 * one `ctx.all` (the same `group.id`) form parallel branches, one per member (`group.index`):
 * each branch starts from what came before the group and leads to what came after it.
 */
export function runGraph(records: readonly GraphRecord[], run: RunSummary): RunGraph {
  const ended = isEnded(run.status);
  const sorted = records.toSorted((a, b) => a.seq - b.seq);
  const lastSeq = sorted.at(-1)?.seq ?? -1;
  const start: GraphNode = { id: "start", kind: "start", label: "start", tone: "ok", seq: -1 };
  const steps: GraphNode[] = [];
  const ops = new Map<number, OpNode>();
  /** The calls with an op.called record: they have run, or failed. */
  const called = new Set<OpNode>();
  const asked = new Map<string, OpNode | ApprovalNode>();
  let end: GraphNode | undefined;

  const opAt = (seq: number, op: string, group: LedgerGroup | undefined): OpNode => {
    let node = ops.get(seq);
    if (!node) {
      node = { id: `op:${seq}`, kind: "op", label: op, op, tone: "active", seq, ...(group ? { group } : {}) };
      ops.set(seq, node);
      steps.push(node);
    }
    return node;
  };

  for (const record of sorted) {
    const group = record.group ? { group: record.group } : {};
    switch (record.type) {
      case "run.started":
        Object.assign(start, { seq: record.seq, recordId: record.id });
        break;
      case "op.called": {
        const node = opAt(record.seq, record.op, record.group);
        called.add(node);
        Object.assign(node, {
          recordId: record.id,
          effect: record.effect,
          decision: record.decision.kind,
          durationMs: record.durationMs,
          ...(record.error ? { errorCode: record.error.code } : {}),
          // The runtime records a call once it has returned or failed.
          tone: record.error || record.decision.kind === "deny" ? "bad" : "ok",
        });
        break;
      }
      case "approval.requested": {
        const hold = {
          approval: record.approval,
          title: record.title,
          approver: approverLabel(record.approver),
          state: "pending" as const,
          refused: 0,
        };
        if (record.requestedBy === "policy" && record.op !== undefined) {
          // The held call takes its seq just before the approval's records (runtime: callOp),
          // and its op.called is written only once it has run: until then, the node is the hold.
          const node = opAt(record.seq - 1, record.op, record.group);
          node.recordId ??= record.id;
          node.hold = hold;
          asked.set(record.approval, node);
        } else {
          const node: ApprovalNode = {
            id: `approval:${record.approval}`,
            kind: "approval",
            label: record.title,
            tone: "waiting",
            seq: record.seq,
            recordId: record.id,
            ...hold,
            ...group,
          };
          asked.set(record.approval, node);
          steps.push(node);
        }
        break;
      }
      case "approval.decided":
      case "approval.refused": {
        const node = asked.get(record.approval);
        const target = node?.kind === "op" ? node.hold : node;
        if (!target) break;
        if (record.type === "approval.refused") target.refused++;
        else target.state = record.decision === "approve" ? "approved" : "rejected";
        break;
      }
      case "sleep.started":
        steps.push({
          id: `sleep:${record.seq}`,
          kind: "sleep",
          label: sleepLabel(record.until),
          until: record.until,
          // Still asleep while it is the run's last record.
          tone: !ended && record.seq === lastSeq ? "waiting" : "ok",
          seq: record.seq,
          recordId: record.id,
          ...group,
        });
        break;
      case "run.finished":
      case "run.failed":
        end = {
          id: "end",
          kind: "end",
          label: record.type === "run.finished" ? "finished" : "failed",
          state: record.type === "run.finished" ? "finished" : "failed",
          tone: record.type === "run.finished" ? "ok" : "bad",
          seq: record.seq,
          recordId: record.id,
          ...(record.type === "run.failed" ? { errorCode: record.error.code } : {}),
        };
        break;
    }
  }

  for (const node of steps) {
    if (node.kind === "approval") node.tone = ended && node.state === "pending" ? "off" : APPROVAL_TONE[node.state];
    if (node.kind === "op" && node.hold && !called.has(node)) {
      // Not recorded yet: waiting on its approval, or running once approved.
      const { state } = node.hold;
      node.tone = state === "rejected" ? "bad" : ended ? "off" : state === "approved" ? "active" : "waiting";
    }
  }
  // Ended without a record (cancelled, say): the run's status. Not ended: a placeholder.
  end ??= ended
    ? { id: "end", kind: "end", label: run.status, state: run.status, tone: RUN_TONE[run.status], seq: lastSeq + 1 }
    : { id: "end", kind: "end", label: "pending", state: "pending", tone: "off", seq: lastSeq + 1 };

  steps.sort((a, b) => a.seq - b.seq);
  const nodes = [start, ...steps, end];
  return { nodes, edges: edgesOf(nodes) };
}

/** A stretch of the graph: one node, or one `ctx.all` with a chain of nodes per member. */
interface Stretch {
  heads: GraphNode[];
  tails: GraphNode[];
  chains: GraphNode[][];
}

function edgesOf(nodes: GraphNode[]): GraphEdge[] {
  const stretches: Stretch[] = [];
  let open: { id: string; branches: Map<number, GraphNode[]> } | undefined;
  const close = () => {
    if (!open) return;
    const chains = [...open.branches].toSorted(([a], [b]) => a - b).map(([, chain]) => chain);
    stretches.push({ heads: chains.map((c) => c[0]!), tails: chains.map((c) => c.at(-1)!), chains });
    open = undefined;
  };
  for (const node of nodes) {
    if (node.group) {
      if (open?.id !== node.group.id) {
        close();
        open = { id: node.group.id, branches: new Map() };
      }
      const chain = open.branches.get(node.group.index);
      if (chain) chain.push(node);
      else open.branches.set(node.group.index, [node]);
      continue;
    }
    close();
    stretches.push({ heads: [node], tails: [node], chains: [[node]] });
  }
  close();

  const edges: GraphEdge[] = [];
  const link = (source: GraphNode, target: GraphNode) =>
    edges.push({
      id: `${source.id}->${target.id}`,
      source: source.id,
      target: target.id,
      active: target.tone === "active",
      pending: target.kind === "end" && target.state === "pending",
    });
  stretches.forEach((stretch, i) => {
    const before = stretches[i - 1];
    if (before) for (const source of before.tails) for (const target of stretch.heads) link(source, target);
    for (const chain of stretch.chains) chain.slice(1).forEach((node, j) => link(chain[j]!, node));
  });
  return edges;
}
