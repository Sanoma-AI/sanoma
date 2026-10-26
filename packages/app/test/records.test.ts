import type { ApprovalState, LedgerBody, LedgerRecord, RunSummary } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { outlineGraph } from "../src/graph/outline-graph.ts";
import { runGraph } from "../src/graph/run-graph.ts";
import type { GraphNode } from "../src/graph/types.ts";
import { nodesByRecord, recordsFor } from "../src/lib/records.ts";

// Hand-built ledgers, as in run-graph.test.ts, drawn by runGraph: the nodes are the page's.

/** A record with this seq, its id `r<seq>`. */
const record = (seq: number, body: LedgerBody): LedgerRecord =>
  ({
    v: 1,
    app: "test",
    id: `r${seq}`,
    runId: "run-1",
    seq,
    at: 1_000 + seq,
    actor: { id: "ada" },
    workflow: "announce",
    ...body,
  }) as LedgerRecord;

const run = (approvals: ApprovalState[]): RunSummary => ({
  runId: "run-1",
  workflow: "announce",
  status: "running",
  createdAt: 1_000,
  approvals,
});

const asked = (id: string, status: ApprovalState["status"], more: Partial<ApprovalState> = {}): ApprovalState => ({
  id,
  title: id,
  approver: "marketing-lead",
  requestedBy: "workflow",
  covers: [],
  status,
  requestedAt: 1_000,
  refused: [],
  ...more,
});

const started: LedgerBody = { type: "run.started", input: {} };
const called = (op: string): LedgerBody => ({
  type: "op.called",
  op,
  effect: "publish",
  input: {},
  decision: { kind: "allow" },
  durationMs: 12,
});
const requested = (approval: string, more: object = {}): LedgerBody => ({
  type: "approval.requested",
  approval,
  title: approval,
  approver: "marketing-lead",
  requestedBy: "workflow",
  covers: [],
  ...more,
});
/** The policy's request holding the call numbered `opSeq`. */
const holding = (approval: string, opSeq: number) =>
  requested(approval, { requestedBy: "policy", op: "ghost.post.create", opSeq });
const decided = (approval: string, decision: "approve" | "reject"): LedgerBody => ({
  type: "approval.decided",
  approval,
  decision,
  by: "lead",
});

const ids = (records: LedgerRecord[]) => records.map((r) => r.id);
const node = (nodes: readonly GraphNode[], id: string) => nodes.find((n) => n.id === id)!;

describe("recordsFor", () => {
  it("gives a held call's own record, then the policy's request and decision on it, in the ledger's order", () => {
    // The call numbered 2 was held, approved, then made; another hold on call 1 is not its.
    const ledger = [
      record(0, started),
      record(1, called("bluesky.post.create")),
      record(2, called("ghost.post.create")),
      record(3, holding("other", 1)),
      record(4, holding("hold", 2)),
      record(5, decided("hold", "approve")),
    ];
    const { nodes } = runGraph(ledger, run([asked("hold", "approved"), asked("other", "pending")]), 0);
    expect(ids(recordsFor(node(nodes, "op:2"), ledger))).toEqual(["r2", "r4", "r5"]);
    expect(ids(recordsFor(node(nodes, "start"), ledger))).toEqual(["r0"]);
  });

  it("gives a held call not made yet its request and what came of it", () => {
    const ledger = [record(0, started), record(3, holding("hold", 2)), record(4, decided("hold", "reject"))];
    const { nodes } = runGraph(ledger, run([asked("hold", "rejected")]), 0);
    expect(ids(recordsFor(node(nodes, "op:2"), ledger))).toEqual(["r3", "r4"]);
  });

  it("gives an approval withdrawn its request and the withdrawal, and its held call the withdrawn tone", () => {
    const withdrawn: LedgerBody = { type: "approval.withdrawn", approval: "hold", reason: "a new commit" };
    const ledger = [record(0, started), record(3, holding("hold", 2)), record(4, withdrawn)];
    const { nodes } = runGraph(ledger, run([asked("hold", "withdrawn")]), 0);
    expect(ids(recordsFor(node(nodes, "op:2"), ledger))).toEqual(["r3", "r4"]);
    expect(node(nodes, "op:2").state?.tone).toBe("off");
  });

  it("gives a workflow's approval its request, the messages it ignored and its decision, not another's", () => {
    const ledger = [
      record(0, started),
      record(1, requested("first")),
      record(2, { type: "approval.refused", approval: "first", by: "mallory", reason: "not the approver" }),
      record(3, decided("first", "approve")),
      record(4, requested("second")),
    ];
    const { nodes } = runGraph(ledger, run([asked("first", "approved"), asked("second", "pending")]), 0);
    expect(ids(recordsFor(node(nodes, "approval:first"), ledger))).toEqual(["r1", "r2", "r3"]);
    expect(ids(recordsFor(node(nodes, "approval:second"), ledger))).toEqual(["r4"]);
  });

  it("gives none for a node with no record: an outline's, or one the run has not reached", () => {
    const ledger = [record(0, started)];
    const outline = outlineGraph([{ kind: "op", id: "ghost.post.create" }]);
    expect(recordsFor(node(outline.nodes, "op:0"), ledger)).toEqual([]);
    const { nodes } = runGraph(ledger, run([]), 0);
    expect(recordsFor(node(nodes, "end"), ledger)).toEqual([]);
  });
});

describe("nodesByRecord", () => {
  it("leads each record to the node that stands for it, and a scenario's seeding to none", () => {
    const ledger = [
      record(0, started),
      record(1, { type: "scenario.seeded", scenario: "Launch", seeds: [] }),
      record(2, requested("first")),
      record(3, decided("first", "approve")),
      record(4, { type: "run.finished", output: {} }),
    ];
    const { nodes } = runGraph(ledger, run([asked("first", "approved")]), 0);
    expect(Object.fromEntries(nodesByRecord(nodes, ledger))).toEqual({
      r0: "start",
      r2: "approval:first",
      r3: "approval:first",
      r4: "end",
    });
  });
});
