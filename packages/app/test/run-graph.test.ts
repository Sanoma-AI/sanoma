import type { ApprovalState, LedgerBody, LedgerGroup, LedgerRecord, RunStatus, RunSummary } from "@sanoma/workflows";
import type { OutlineNode } from "@sanoma/workflows/describe";
import { describe, expect, it } from "vitest";
import { runGraph } from "../src/graph/run-graph.ts";
import { pairs, spans, summary } from "./graph-helpers.ts";

// Hand-built ledgers, in the shapes the runtime writes (see packages/workflows/src/ledger.ts).

type Body = LedgerBody & { group?: LedgerGroup };

/** A record with this seq. */
const record = (seq: number, body: Body): LedgerRecord =>
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

/** A run's records from their bodies, numbered in order. */
const ledger = (...bodies: Body[]): LedgerRecord[] => bodies.map((body, seq) => record(seq, body));

const run = (status: RunStatus, approvals: ApprovalState[] = []): RunSummary => ({
  runId: "run-1",
  workflow: "announce",
  status,
  createdAt: 1_000,
  approvals,
});

const approval = (status: ApprovalState["status"], more: Partial<ApprovalState> = {}): ApprovalState => ({
  id: "approval-1",
  title: "Send it?",
  approver: "marketing-lead",
  requestedBy: "workflow",
  covers: [],
  status,
  requestedAt: 1_000,
  refused: [],
  ...more,
});

const NOW = Date.UTC(2026, 9, 9, 8, 0);
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
/** A workflow's approval, asked for. */
const requested = (title: string, id = `approval-${title}`, more: object = {}): Body => ({
  type: "approval.requested",
  approval: id,
  title,
  approver: "marketing-lead",
  requestedBy: "workflow",
  covers: [],
  ...more,
});
/** A sleep, until a time. */
const slept = (until: number, more: object = {}): Body => ({ type: "sleep.started", until, ...more });
const inGroup = (body: Body, index: number, size = 3, id = "all:1"): Body => ({ ...body, group: { id, index, size } });

describe("runGraph", () => {
  it("draws a straight run as a chain in seq order", () => {
    const { nodes, edges } = runGraph(
      ledger(started, called("ghost.post.create"), called("resend.broadcast.send", { effect: "send" }), {
        type: "run.finished",
        output: {},
      }),
      run("finished"),
      NOW,
    );
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "end ok"]);
    expect(pairs(edges)).toEqual(["start->op:1", "op:1->op:2", "op:2->end"]);
    expect(nodes[1]).toEqual({
      id: "op:1",
      kind: "op",
      label: "ghost.post.create",
      state: { tone: "ok", recordId: "r1", decision: "allow", durationMs: 12 },
    });
    expect(nodes.at(-1)).toEqual({
      id: "end",
      kind: "end",
      label: "finished",
      state: { tone: "ok", recordId: "r3" },
    });
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
      NOW,
    );
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "op:3 bad", "end bad"]);
    expect(nodes[3]).toMatchObject({ state: { errorCode: "driver_failed" } });
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
      NOW,
    );
    expect(pairs(edges)).toEqual([
      "start->op:1",
      "op:1->op:2",
      "start->op:3",
      "start->op:4",
      "op:2->op:5",
      "op:3->op:5",
      "op:4->op:5",
      "op:5->end",
    ]);
  });

  it("keeps two fan-outs in a row apart by their ids, the second joined after the first", () => {
    const { nodes, edges } = runGraph(
      ledger(
        started,
        inGroup(called("a.x.one"), 0, 2),
        inGroup(called("b.x.one"), 1, 2),
        inGroup(called("a.x.two"), 0, 2, "all:3"),
        inGroup(called("b.x.two"), 1, 2, "all:3"),
        { type: "run.finished", output: {} },
      ),
      run("finished"),
      NOW,
    );
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "op:3 ok", "op:4 ok", "end ok"]);
    expect(pairs(edges)).toEqual([
      "start->op:1",
      "start->op:2",
      "op:1->op:3",
      "op:2->op:3",
      "op:1->op:4",
      "op:2->op:4",
      "op:3->end",
      "op:4->end",
    ]);
  });

  it("draws the members of a fan-out in progress that have recorded nothing as pending lanes", () => {
    const records = ledger(
      started,
      inGroup(called("ghost.post.create"), 0),
      inGroup(called("resend.broadcast.create"), 1),
    );
    const { nodes, edges } = runGraph(records, run("running"), NOW);
    expect(summary(nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "pending:all:1:2 -", "end off"]);
    expect(nodes[3]).toEqual({ id: "pending:all:1:2", kind: "pending", label: "not started" });
    expect(pairs(edges)).toEqual([
      "start->op:1",
      "start->op:2",
      "start->pending:all:1:2",
      "op:1->end",
      "op:2->end",
      "pending:all:1:2->end",
    ]);

    // Once the run has gone on, or ended, a member with no record never ran.
    const after = runGraph([...records, record(3, called("stats.post.views"))], run("running"), NOW);
    expect(after.nodes.some((n) => n.kind === "pending")).toBe(false);
    expect(runGraph(records, run("cancelled"), NOW).nodes.some((n) => n.kind === "pending")).toBe(false);
  });

  it("draws a sleep, waiting while it is the run's last record and its time has not come", () => {
    const until = NOW + 60_000;
    const sleeping = ledger(started, { type: "sleep.started", until });
    const { nodes, edges } = runGraph(sleeping, run("running"), NOW);
    expect(nodes[1]).toEqual({
      id: "sleep:1",
      kind: "sleep",
      label: "until 2026-10-09 08:01 UTC",
      state: { tone: "waiting", recordId: "r1" },
    });
    expect(nodes[2]).toEqual({ id: "end", kind: "end", label: "pending", pending: true, state: { tone: "off" } });
    expect(edges.at(-1)).toMatchObject({ source: "sleep:1", target: "end" });

    // Its time has come: the run is on to its next call, so the pending end moves.
    const woke = runGraph(sleeping, run("running"), until + 1);
    expect(summary(woke.nodes)).toEqual(["start ok", "sleep:1 ok", "end active"]);

    const followed = runGraph([...sleeping, record(2, called("ghost.post.create"))], run("running"), NOW);
    expect(followed.nodes[1]).toMatchObject({ kind: "sleep", state: { tone: "ok" } });
  });

  it("draws a workflow's approval as a node, as the run's approvals tell it", () => {
    const records = ledger(started, requested("Send it?", "approval-1"), {
      type: "approval.refused",
      approval: "approval-1",
      by: "mallory",
      reason: "not the approver",
    });
    const pending = approval("pending");
    const waiting = runGraph(records, run("waiting", [pending]), NOW);
    expect(summary(waiting.nodes)).toEqual(["start ok", "approval:approval-1 waiting", "end off"]);
    expect(waiting.nodes[1]).toEqual({
      id: "approval:approval-1",
      kind: "approval",
      label: "“Send it?”",
      state: { tone: "waiting", recordId: "r1", approval: pending },
    });

    const decided = runGraph(records, run("running", [approval("approved")]), NOW);
    expect(summary(decided.nodes)).toEqual(["start ok", "approval:approval-1 ok", "end off"]);
    // Never decided: the run ended without it.
    const cancelled = runGraph(records, run("cancelled", [pending]), NOW);
    expect(summary(cancelled.nodes)).toEqual(["start ok", "approval:approval-1 off", "end off"]);
  });

  it("draws a policy's approval on the call it holds, found by its opSeq", () => {
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
        opSeq: 2,
      }),
    ];
    const asked = approval("pending", { requestedBy: "policy", op: "ghost.post.create", opSeq: 2 });
    const pending = runGraph(held, run("waiting", [asked]), NOW);
    expect(summary(pending.nodes)).toEqual(["start ok", "op:1 ok", "op:2 waiting", "end off"]);
    expect(pending.nodes[2]).toEqual({
      id: "op:2",
      kind: "op",
      label: "ghost.post.create",
      state: { tone: "waiting", recordId: "r3", approval: asked },
    });

    // Approved, not yet recorded: the call is in flight.
    const approved = { ...asked, status: "approved" } as const;
    const running = runGraph(held, run("running", [approved]), NOW);
    expect(summary(running.nodes)).toEqual(["start ok", "op:1 ok", "op:2 active", "end off"]);

    // Recorded: the call's own record and outcome, with its approval kept on it.
    const done = runGraph(
      [...held.slice(0, 2), record(2, called("ghost.post.create")), held[2]!],
      run("running", [approved]),
      NOW,
    );
    expect(summary(done.nodes)).toEqual(["start ok", "op:1 ok", "op:2 ok", "end off"]);
    expect(done.nodes[2]).toMatchObject({ state: { recordId: "r2", decision: "allow", approval: approved } });
  });

  it("draws a run still running with no records as start and a pending end", () => {
    const { nodes, edges } = runGraph([], run("running"), NOW);
    expect(nodes).toEqual([
      { id: "start", kind: "start", label: "start", state: { tone: "ok" } },
      { id: "end", kind: "end", label: "pending", pending: true, state: { tone: "off" } },
    ]);
    expect(edges).toEqual([{ id: "start->end", source: "start", target: "end" }]);
  });

  it("ends a run that ended without a record with its status", () => {
    const { nodes } = runGraph(ledger(started, called("ghost.post.create")), run("cancelled"), NOW);
    expect(nodes.at(-1)).toEqual({ id: "end", kind: "end", label: "cancelled", state: { tone: "off" } });
  });

  it("marks a denied call bad and keeps the policy's decision", () => {
    const denied = called("ghost.post.create", {
      decision: { kind: "deny", reason: "no" },
      output: undefined,
      error: { code: "policy_denied", name: "PolicyDeniedError", message: "no" },
      durationMs: 0,
    });
    const { nodes } = runGraph(ledger(started, denied), run("running"), NOW);
    expect(nodes[1]).toMatchObject({ state: { tone: "bad", decision: "deny", errorCode: "policy_denied" } });
  });

  describe("given the workflow's outline", () => {
    // ghost.post.create, then resend.broadcast.send in both arms of a branch, then an approval and a
    // sleep in a loop, then a try whose handler posts again.
    const outline: OutlineNode[] = [
      { kind: "op", path: "0", id: "ghost.post.create", span: [0, 10] },
      {
        kind: "branch",
        path: "1",
        span: [15, 55],
        cases: [
          [{ kind: "op", path: "1.0.0", id: "resend.broadcast.send", span: [20, 30] }],
          [{ kind: "op", path: "1.1.0", id: "resend.broadcast.send", span: [40, 50] }],
        ],
      },
      {
        kind: "repeat",
        path: "2",
        span: [60, 120],
        body: [
          { kind: "approval", path: "2.0.0", title: "Send it?", span: [70, 80] },
          { kind: "sleep", path: "2.0.1", span: [100, 110] },
        ],
      },
      {
        kind: "try",
        path: "3",
        span: [130, 180],
        body: [{ kind: "op", path: "3.0.0", id: "ghost.post.create", span: [140, 150] }],
        handler: [{ kind: "op", path: "3.1.0", id: "ghost.post.create", span: [160, 170] }],
      },
    ];
    const spansIn = (records: LedgerRecord[]) => spans(runGraph(records, run("running"), NOW, outline).nodes);

    it("points each call at the node its record names: a loop's passes at one, two calls of one operation at their two", () => {
      const until = NOW + 60_000;
      expect(
        spansIn(
          ledger(
            started,
            called("ghost.post.create", { node: "0" }),
            called("resend.broadcast.send", { node: "1.1.0" }),
            requested("Send it?", "a1", { node: "2.0.0" }),
            slept(until, { node: "2.0.1" }),
            requested("Send it?", "a2", { node: "2.0.0" }),
            slept(until, { node: "2.0.1" }),
            called("ghost.post.create", { node: "3.0.0" }),
            called("ghost.post.create", { node: "3.1.0" }),
          ),
        ),
      ).toEqual([
        "start null",
        "op:1 [0,10]",
        "op:2 [40,50]",
        "approval:a1 [70,80]",
        "sleep:4 [100,110]",
        "approval:a2 [70,80]",
        "sleep:6 [100,110]",
        "op:7 [140,150]",
        "op:8 [160,170]",
        "end null",
      ]);
    });

    it("points a call nowhere when its record names no node, or the outline has no such node or another call there", () => {
      expect(
        spansIn(
          ledger(
            started,
            called("ghost.post.create"),
            called("ghost.post.create", { node: "9" }),
            // The file changed since the run: a sleep, and another operation, where the call was.
            called("ghost.post.create", { node: "2.0.1" }),
            called("ghost.post.create", { node: "1.0.0" }),
            requested("Other", "a1", { node: "2.0.0" }),
          ),
        ),
      ).toEqual(["start null", "op:1 null", "op:2 null", "op:3 null", "op:4 null", "approval:a1 null", "end null"]);
    });

    it("places a call at a computed operation (`*`) that fits it, and an approval at a computed title", () => {
      const computed: OutlineNode[] = [
        { kind: "op", path: "0", id: "*.post.create", span: [0, 10] },
        { kind: "approval", path: "1", span: [20, 30] },
      ];
      const { nodes } = runGraph(
        ledger(started, called("ghost.post.create", { node: "0" }), requested("Any", "a1", { node: "1" })),
        run("running"),
        NOW,
        computed,
      );
      expect(spans(nodes)).toEqual(["start null", "op:1 [0,10]", "approval:a1 [20,30]", "end null"]);
    });

    it("places a policy's held call at the node its approval names", () => {
      const held = requested("Hold", "h1", { op: "ghost.post.create", opSeq: 2, node: "3.0.0", requestedBy: "policy" });
      expect(spansIn(ledger(started, held))).toEqual(["start null", "op:2 [140,150]", "end null"]);
    });
  });
});
