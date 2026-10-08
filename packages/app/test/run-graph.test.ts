import type { RunStatus, RunSummary } from "@sanoma/workflows";
import { describe, expect, it } from "vitest";
import type { GraphRecord, LedgerGroup } from "../src/api.ts";
import { type GraphNode, runGraph } from "../src/graph/run-graph.ts";

// Hand-built ledgers, in the shapes the runtime writes (see packages/workflows/src/ledger.ts).

type Body = GraphRecord extends infer R ? (R extends GraphRecord ? Omit<R, keyof Common> : never) : never;
type Common = Pick<GraphRecord, "v" | "app" | "id" | "runId" | "seq" | "at" | "actor" | "workflow">;

/** A record with this seq, its id made the way the runtime makes it. */
function record(seq: number, body: Body): GraphRecord {
  const key = body.type === "approval.requested" || body.type === "approval.decided" ? body.approval : seq;
  return {
    v: 1,
    app: "test",
    id: `run-1:${body.type}:${key}`,
    runId: "run-1",
    seq,
    at: 1_000 + seq,
    actor: { id: "ada" },
    workflow: "announce",
    ...body,
  } as GraphRecord;
}

/** A run's records from their bodies, numbered in order. */
const ledger = (...bodies: Body[]): GraphRecord[] => bodies.map((body, seq) => record(seq, body));

const run = (status: RunStatus): RunSummary => ({
  runId: "run-1",
  workflow: "announce",
  status,
  createdAt: 1_000,
  approvals: [],
});

const allow = { kind: "allow" } as const;
const started: Body = { type: "run.started", input: {} };
const called = (op: string, more: object = {}): Body => ({
  type: "op.called",
  op,
  effect: "publish",
  input: {},
  decision: allow,
  output: { ok: true },
  durationMs: 12,
  ...more,
});
const inGroup = (body: Body, index: number, id = "all:0"): Body => ({
  ...body,
  group: { id, index, size: 3 } satisfies LedgerGroup,
});

const summary = (nodes: GraphNode[]) => nodes.map((n) => `${n.id} ${n.tone}`);
const pairs = (edges: { source: string; target: string }[]) => edges.map((e) => `${e.source}->${e.target}`);

describe("runGraph", () => {
  it("draws a straight run as a chain in seq order", () => {
    const { nodes, edges } = runGraph(
      ledger(started, called("ghost.post.create"), called("resend.broadcast.send", { effect: "send" }), {
        type: "run.finished",
        output: {},
      }),
      run("finished"),
    );
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "end ok"]);
    expect(pairs(edges)).toEqual(["start->op:1", "op:1->op:2", "op:2->end"]);
    const op = nodes[1]!;
    expect(op).toMatchObject({
      kind: "op",
      label: "ghost.post.create",
      effect: "publish",
      decision: "allow",
      durationMs: 12,
      seq: 1,
      recordId: "run-1:op.called:1",
    });
    expect(nodes.at(-1)).toMatchObject({ kind: "end", state: "finished", recordId: "run-1:run.finished:3" });
    expect(edges.some((e) => e.active || e.pending)).toBe(false);
  });

  it("draws a ctx.all as parallel branches, and none for members that never ran", () => {
    const failure = { code: "driver_failed", name: "DriverError", message: "boom" } as const;
    const { nodes, edges } = runGraph(
      ledger(
        started,
        called("ghost.post.create"),
        inGroup(called("bluesky.post.create"), 0),
        inGroup(called("resend.broadcast.send", { output: undefined, error: failure }), 1),
        // The third member never ran: the first failure stops the group.
        { type: "run.failed", error: failure },
      ),
      run("failed"),
    );
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "op:3 bad", "end bad"]);
    expect(nodes[3]).toMatchObject({ errorCode: "driver_failed" });
    expect(pairs(edges)).toEqual(["start->op:1", "op:1->op:2", "op:1->op:3", "op:2->end", "op:3->end"]);
  });

  it("chains a member's calls and joins three branches to what follows", () => {
    const { edges } = runGraph(
      ledger(
        started,
        inGroup(called("a.x.one"), 0),
        inGroup(called("a.x.two"), 0),
        inGroup(called("b.x.one"), 1),
        inGroup(called("c.x.one"), 2),
        called("d.x.after"),
      ),
      run("running"),
    );
    expect(pairs(edges)).toEqual([
      "start->op:1",
      "start->op:3",
      "start->op:4",
      "op:1->op:2",
      "op:2->op:5",
      "op:3->op:5",
      "op:4->op:5",
      "op:5->end",
    ]);
  });

  it("draws a sleep, waiting while it is the run's last record", () => {
    const until = Date.UTC(2026, 9, 9, 8, 30);
    const sleeping = ledger(started, { type: "sleep.started", until });
    const { nodes } = runGraph(sleeping, run("running"));
    expect(nodes[1]).toMatchObject({
      id: "sleep:1",
      kind: "sleep",
      label: "sleep until 2026-10-09 08:30 UTC",
      until,
      tone: "waiting",
    });
    expect(nodes[2]).toMatchObject({ kind: "end", state: "pending", tone: "off" });

    const woke = runGraph(
      ledger(started, { type: "sleep.started", until }, called("ghost.post.create")),
      run("running"),
    );
    expect(woke.nodes[1]).toMatchObject({ kind: "sleep", tone: "ok" });
  });

  it("draws a workflow's approval as a node, and a policy's on the call it holds", () => {
    const records = ledger(
      started,
      {
        type: "approval.requested",
        approval: "approval-1",
        title: "Send it?",
        approver: "marketing-lead",
        requestedBy: "workflow",
        covers: [],
      },
      { type: "approval.refused", approval: "approval-1", by: "mallory", reason: "not the approver" },
    );
    const waiting = runGraph(records, run("waiting"));
    expect(summary(waiting.nodes)).toEqual(["start ok", "approval:approval-1 waiting", "end off"]);
    expect(waiting.nodes[1]).toMatchObject({
      kind: "approval",
      label: "Send it?",
      approver: "marketing-lead",
      state: "pending",
      refused: 1,
      recordId: "run-1:approval.requested:approval-1",
    });
    expect(waiting.edges.at(-1)).toMatchObject({ target: "end", pending: true });

    // The policy holds the call numbered 2; its op.called comes only once the call has run.
    const held = [
      record(0, started),
      record(1, called("bluesky.post.create")),
      record(3, {
        type: "approval.requested",
        approval: "approval-1",
        title: "Publish?",
        approver: { group: "marketing" },
        requestedBy: "policy",
        covers: ["ghost.post.create"],
        op: "ghost.post.create",
      }),
    ];
    const pending = runGraph(held, run("waiting"));
    expect(summary(pending.nodes)).toEqual(["start ok", "op:1 ok", "op:2 waiting", "end off"]);
    expect(pending.nodes[2]).toMatchObject({
      kind: "op",
      label: "ghost.post.create",
      recordId: "run-1:approval.requested:approval-1",
      hold: { approval: "approval-1", title: "Publish?", approver: "group marketing", state: "pending", refused: 0 },
    });
    expect(pending.nodes[2]).not.toHaveProperty("effect");

    // Approved, not yet recorded: the call is in flight, and the edge into it moves.
    const decided = [
      ...held,
      record(4, { type: "approval.decided", approval: "approval-1", decision: "approve", by: "ada" }),
    ];
    const running = runGraph(decided, run("running"));
    expect(summary(running.nodes)).toEqual(["start ok", "op:1 ok", "op:2 active", "end off"]);
    expect(running.edges.find((e) => e.target === "op:2")).toMatchObject({ active: true });
    expect(running.nodes[2]).toMatchObject({ hold: { state: "approved" } });

    // Recorded: the call's own record, its effect and outcome, with the hold kept on it.
    const done = runGraph([...decided, record(2, called("ghost.post.create"))], run("running"));
    expect(summary(done.nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "end off"]);
    expect(done.nodes[2]).toMatchObject({
      recordId: "run-1:op.called:2",
      effect: "publish",
      hold: { state: "approved" },
    });
  });

  it("draws a run still running with no records as start and a pending end", () => {
    const { nodes, edges } = runGraph([], run("running"));
    expect(nodes.map((n) => [n.id, n.kind])).toEqual([
      ["start", "start"],
      ["end", "end"],
    ]);
    expect(nodes[1]).toMatchObject({ state: "pending", label: "pending" });
    expect(edges).toEqual([{ id: "start->end", source: "start", target: "end", active: false, pending: true }]);
  });

  it("ends a run that ended without a record with its status", () => {
    const { nodes } = runGraph(ledger(started, called("ghost.post.create")), run("cancelled"));
    expect(nodes.at(-1)).toMatchObject({ kind: "end", state: "cancelled", tone: "off" });
  });

  it("marks a denied call bad and keeps the policy's decision", () => {
    const denied = called("ghost.post.create", {
      decision: { kind: "deny", reason: "no" },
      output: undefined,
      error: { code: "policy_denied", name: "PolicyDeniedError", message: "no" },
      durationMs: 0,
    });
    const { nodes } = runGraph(ledger(started, denied), run("running"));
    expect(nodes[1]).toMatchObject({ tone: "bad", decision: "deny", errorCode: "policy_denied" });
  });
});
