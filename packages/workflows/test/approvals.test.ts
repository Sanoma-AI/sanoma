import { randomUUID } from "node:crypto";
import { bluesky } from "@sanoma/connector-bluesky";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sameApprover } from "../src/define.ts";
import {
  allow,
  approve,
  approvedFor,
  type ApprovalState,
  decisionEventOf,
  definePolicy,
  defineWorkflow,
  errorCode,
  type LedgerRecord,
  mayDecide,
  type Policy,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("approvals");
const alice = { id: "alice" };
const lead = { id: "marketing-lead" };
const input = (title: string) => ({ title, body: "<p>x</p>", launchAt: inSeconds(-1) });

const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

const ofType = <T extends LedgerRecord["type"]>(records: LedgerRecord[], type: T) =>
  records.filter((r): r is Extract<LedgerRecord, { type: T }> => r.type === type);

/** Asks for an approval as given, so a test can send one the runtime must refuse. */
const odd = defineWorkflow({
  name: "odd",
  trigger: "manual",
  input: z.object({ request: z.any() }),
  uses: ["approval"],
  run: async (ctx, { request }) => ctx.approval("Odd", request),
});

/** A workflow that asks someone of its choosing to sign off a post, then posts. */
const launder = defineWorkflow({
  name: "launder",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create, "approval"],
  run: async (ctx, { text }) => {
    await ctx.approval("Looks fine", { approver: "intern", covers: [bluesky.post.create] });
    return ctx.bluesky.post.create({ text });
  },
});

/** One post, which the "group" policy holds for the marketing group. */
const shout = defineWorkflow({
  name: "shout",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
  run: async (ctx, { text }) => ctx.bluesky.post.create({ text }),
});

/** An approval in a run, with the parts approvedFor reads set as the test needs. */
const state = (over: Partial<ApprovalState>): ApprovalState => ({
  id: "approval-1",
  title: "Refund",
  requestedBy: "workflow",
  approver: "lead",
  covers: ["shop.order.refund"],
  status: "approved",
  requestedAt: 0,
  refused: [],
  ...over,
});

describe("approvedFor", () => {
  const refund = "shop.order.refund";

  it("is true for an approval that is approved, covers the operation, and was addressed to that approver", () => {
    expect(approvedFor([state({})], refund, "lead")).toBe(true);
    expect(approvedFor([state({ status: "pending" }), state({ id: "approval-2" })], refund, "lead")).toBe(true);
    const group = { group: "finance" };
    expect(approvedFor([state({ approver: group })], refund, { group: "finance" })).toBe(true);
  });

  it("is false when any of the three is missing", () => {
    expect(approvedFor([], refund, "lead")).toBe(false);
    expect(approvedFor([state({ status: "pending" })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ status: "rejected" })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ covers: [] })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ covers: ["shop.order.get"] })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ approver: "intern" })], refund, "lead")).toBe(false);
    // A person and a group of the same name are different approvers.
    expect(approvedFor([state({ approver: { group: "lead" } })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ approver: "lead" })], refund, { group: "lead" })).toBe(false);
    expect(approvedFor([state({ approver: { group: "sales" } })], refund, { group: "finance" })).toBe(false);
  });

  it("compares approvers by kind and name", () => {
    expect(sameApprover("lead", "lead")).toBe(true);
    expect(sameApprover("lead", "intern")).toBe(false);
    expect(sameApprover("lead", { group: "lead" })).toBe(false);
    expect(sameApprover({ group: "lead" }, "lead")).toBe(false);
    expect(sameApprover({ group: "finance" }, { group: "finance" })).toBe(true);
    expect(sameApprover({ group: "finance" }, { group: "sales" })).toBe(false);
  });
});

describe("mayDecide", () => {
  it("matches a named approver by id, and a group approver by the principal's groups", () => {
    expect(mayDecide({ approver: "lead" }, { id: "lead" })).toBe(true);
    expect(mayDecide({ approver: "lead" }, { id: "intern", groups: ["lead"] })).toBe(false);
    expect(mayDecide({ approver: { group: "marketing" } }, { id: "carol", groups: ["ops", "marketing"] })).toBe(true);
    expect(mayDecide({ approver: { group: "marketing" } }, { id: "marketing" })).toBe(false);
    expect(mayDecide({ approver: { group: "marketing" } }, { id: "bob", groups: [] })).toBe(false);
  });
});

describe("approvals a workflow asks for", () => {
  const app = useApp(databaseUrl, "approvals", () => ({ workflows: [announce, odd] }));
  const c = () => app.client;

  it("fails the run with invalid_input, asking nobody, when the request names no approver or covers no operations", async () => {
    const bad: [unknown, RegExp][] = [
      [{}, /^ctx\.approval\("Odd"\): approver: needs an approver/],
      [{ approver: "lead", covers: ["ghost.post.publish"] }, /covers must be a list of operations/],
      [{ approver: "lead", links: "https://example.com" }, /links must be a list of strings/],
    ];
    const runs = await Promise.all(bad.map(([request]) => c().start(odd, { request }, { startedBy: alice })));
    for (const [i, runId] of runs.entries()) {
      const [request, message] = bad[i]!;
      const err = await caught(c().result(runId));
      expect(errorCode(err), JSON.stringify(request)).toBe("invalid_input");
      expect(err).toMatchObject({ message: expect.stringMatching(message), data: { title: "Odd" } });
      expect(await c().approvals(runId)).toEqual([]);
      expect((await c().ledger(runId)).map((r) => r.type)).toEqual(["run.started", "run.failed"]);
    }
  });

  it("returns the approval still pending while no worker reads it, and the run reads it once one does", async () => {
    const runId = await c().start(announce, input("Nobody home"), { startedBy: alice });
    await waitFor(pending(c, runId));
    await app.stop();
    try {
      const sent = await c().decide(runId, { id: "m-1", decision: "approve", by: lead }, undefined, {
        timeoutSeconds: 1,
      });
      expect(sent).toMatchObject({ id: "approval-1", status: "pending" });
      // The same message again, as a retried send: the key keeps it to one message.
      await app.raw.send(runId, { id: "m-1", decision: "approve", by: lead }, "approval-1", "approval-1:m-1");
    } finally {
      await app.restart();
    }
    await c().result(runId);
    expect((await c().approvals(runId))[0]).toMatchObject({ status: "approved", decidedWith: "m-1" });
    const records = await c().ledger(runId);
    expect(ofType(records, "approval.decided")).toHaveLength(1);
    expect(ofType(records, "approval.refused")).toEqual([]);
  });

  it("refuses anyone but the approver, before sending and again in the run, and records the refusal", async () => {
    const runId = await c().start(announce, input("Wrong approver"), { startedBy: alice });
    await waitFor(pending(c, runId));

    const wrong = await caught(c().decide(runId, { decision: "approve", by: { id: "intern" } }));
    expect(errorCode(wrong)).toBe("not_approver");
    expect(wrong).toMatchObject({
      message: "intern is not the approver; marketing-lead is (approval-1)",
      data: { runId, approvalId: "approval-1", approver: "marketing-lead" },
    });
    expect((await c().approvals(runId))[0]).toMatchObject({ status: "pending", refused: [] });

    // Sent around the client's check: the run checks the sender too.
    await app.raw.send(runId, { decision: "approve", by: { id: "intern" } }, "approval-1");
    await waitFor(async () => (await c().approvals(runId))[0]?.refused.length === 1);
    expect((await c().approvals(runId))[0]).toMatchObject({
      status: "pending",
      refused: [{ by: "intern", at: expect.any(Number), reason: "intern is not the approver; marketing-lead is" }],
    });
    expect(app.ops()).toHaveLength(2);

    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    const records = await c().ledger(runId);
    expect(ofType(records, "approval.refused")).toEqual([
      expect.objectContaining({
        id: `${runId}:approval.refused:approval-1:refused:1`,
        approval: "approval-1",
        by: "intern",
        reason: "intern is not the approver; marketing-lead is",
      }),
    ]);
    expect(ofType(records, "approval.requested")).toEqual([
      expect.objectContaining({ approver: "marketing-lead", requestedBy: "workflow", covers: [] }),
    ]);
  });

  it("returns the approval as decided, from the run's decision event, not as it was sent", async () => {
    const runId = await c().start(announce, input("Decided"), { startedBy: alice });
    await waitFor(pending(c, runId));

    const decided = await c().decide(runId, { decision: "approve", by: lead, note: "ship it" });
    expect(decided).toMatchObject({
      id: "approval-1",
      status: "approved",
      decidedBy: "marketing-lead",
      decidedAt: expect.any(Number),
      note: "ship it",
      covers: [],
    });
    // The run publishes the list before the decision, so the list already shows it.
    expect((await c().approvals(runId))[0]).toEqual(decided);
    expect(await app.raw.getEvent<ApprovalState>(runId, decisionEventOf("approval-1"), 0)).toEqual(decided);
    await c().result(runId);
  });

  it("refuses a second decision as already_decided, and one with nothing to decide as no_pending_approval", async () => {
    const runId = await c().start(announce, input("Twice"), { startedBy: alice });
    await waitFor(pending(c, runId));

    const unknown = await caught(c().decide(runId, { decision: "approve", by: lead }, "approval-9"));
    expect(errorCode(unknown)).toBe("no_pending_approval");
    const garbled = await caught(c().decide(runId, { decision: "maybe", by: lead } as never));
    expect(errorCode(garbled)).toBe("invalid_input");
    expect((await c().approvals(runId))[0]).toMatchObject({ status: "pending", refused: [] });

    await c().decide(runId, { decision: "approve", by: lead });
    const again = await caught(c().decide(runId, { decision: "reject", by: lead }, "approval-1"));
    expect(errorCode(again)).toBe("already_decided");
    expect(again).toMatchObject({
      data: { runId, approvalId: "approval-1", status: "approved", decidedBy: "marketing-lead" },
    });

    await c().result(runId);
    const none = await caught(c().decide(runId, { decision: "approve", by: lead }));
    expect(errorCode(none)).toBe("run_ended");
    expect(none).toMatchObject({ data: { runId, status: "finished" } });
    expect(app.ops()).toHaveLength(5);
  });

  it("says run_ended, without sending, for a decision on a run that has failed or been cancelled", async () => {
    const rejected = await c().start(announce, input("Rejected"), { startedBy: alice });
    await waitFor(pending(c, rejected));
    await c().decide(rejected, { decision: "reject", by: lead });
    expect(errorCode(await caught(c().result(rejected)))).toBe("approval_rejected");
    const failed = await caught(c().decide(rejected, { decision: "approve", by: lead }));
    expect(errorCode(failed)).toBe("run_ended");
    expect(failed).toMatchObject({ message: `Run ${rejected} has failed; it takes no more decisions` });

    // Cancelled while its approval was pending: the approval still says so, but no run will read a decision.
    const cancelled = await c().start(announce, input("Cancelled"), { startedBy: alice });
    await waitFor(pending(c, cancelled));
    await app.raw.cancelWorkflow(cancelled);
    await waitFor(async () => (await c().run(cancelled))?.status === "cancelled");
    const ended = await caught(c().decide(cancelled, { decision: "approve", by: lead }));
    expect(errorCode(ended)).toBe("run_ended");
    expect(ended).toMatchObject({ data: { runId: cancelled, status: "cancelled", approvalId: "approval-1" } });
    expect((await c().approvals(cancelled))[0]?.status).toBe("pending");
  });

  it("says run_not_found for a decision on a run that does not exist", async () => {
    const missing = randomUUID();
    const err = await caught(c().decide(missing, { decision: "approve", by: lead }, "approval-1"));
    expect(errorCode(err)).toBe("run_not_found");
    expect(err).toMatchObject({ message: `No run ${missing}`, data: { runId: missing } });
  });
});

describe("approvals a policy asks for", () => {
  // The test picks a policy per run by actor.
  const byActor: Record<string, Policy> = {
    // The README's policy: each publishing operation needs an approval that covers it.
    each: ({ effect, op, run }) =>
      effect === "publish" && !approvedFor(run.approvals, op.id, "marketing-lead")
        ? approve("marketing-lead")
        : allow(),
    broad: ({ effect, op, run }) =>
      effect === "publish" && !approvedFor(run.approvals, op.id, "marketing-lead")
        ? approve("marketing-lead", { title: "Publish everywhere", covers: [bluesky.post.create] })
        : allow(),
    group: ({ op, run }) =>
      approvedFor(run.approvals, op.id, { group: "marketing" }) ? allow() : approve({ group: "marketing" }),
  };
  const policy = definePolicy((call) => byActor[call.actor.id]?.(call) ?? allow());
  const app = useApp(databaseUrl, "approvals-policy", () => ({ workflows: [announce, shout, launder], policy }));
  const c = () => app.client;

  it("covers only the held operation by default, so a later publish of another one is held again", async () => {
    const runId = await c().start(announce, input("Each"), { startedBy: { id: "each" } });
    await waitFor(pending(c, runId));
    // The workflow's own approval covers nothing, so it lets no call through.
    await c().decide(runId, { decision: "approve", by: lead });

    await waitFor(pending(c, runId, 2));
    expect((await c().approvals(runId))[1]).toMatchObject({
      title: "ghost.post.publish needs marketing-lead",
      requestedBy: "policy",
      op: "ghost.post.publish",
      covers: ["ghost.post.publish"],
    });
    await c().decide(runId, { decision: "approve", by: lead });

    await waitFor(pending(c, runId, 3));
    expect((await c().approvals(runId))[2]).toMatchObject({
      op: "bluesky.post.create",
      covers: ["bluesky.post.create"],
    });
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "ghost.post.publish",
      "resend.broadcast.send",
    ]);
    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);

    const requested = ofType(await c().ledger(runId), "approval.requested");
    expect(requested.map((r) => r.covers)).toEqual([[], ["ghost.post.publish"], ["bluesky.post.create"]]);
  });

  it("delivers two decisions that reuse one message id, on two approvals of a run", async () => {
    const runId = await c().start(announce, input("Same id"), { startedBy: { id: "each" } });
    await waitFor(pending(c, runId));
    const first = await c().decide(runId, { id: "same", decision: "approve", by: lead });
    expect(first).toMatchObject({ id: "approval-1", status: "approved", decidedWith: "same" });
    await waitFor(pending(c, runId, 2));
    const second = await c().decide(runId, { id: "same", decision: "approve", by: lead }, undefined, {
      timeoutSeconds: 10,
    });
    expect(second).toMatchObject({ id: "approval-2", status: "approved", decidedWith: "same" });
    await waitFor(pending(c, runId, 3));
    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
  });

  it("lets a later call through when the policy's approval covers its operation too", async () => {
    const runId = await c().start(announce, input("Broad"), { startedBy: { id: "broad" } });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: lead });
    await waitFor(pending(c, runId, 2));
    expect((await c().approvals(runId))[1]).toMatchObject({
      title: "Publish everywhere",
      op: "ghost.post.publish",
      covers: ["ghost.post.publish", "bluesky.post.create"],
    });

    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect(await c().approvals(runId)).toHaveLength(2);
    expect(app.ops()).toHaveLength(5);

    const calls = ofType(await c().ledger(runId), "op.called");
    // The decision is recorded with the operations it named, by id.
    expect(calls.find((r) => r.op === "ghost.post.publish")?.decision).toEqual({
      kind: "approve",
      approver: "marketing-lead",
      title: "Publish everywhere",
      covers: ["bluesky.post.create"],
    });
    expect(calls.find((r) => r.op === "bluesky.post.create")?.decision).toEqual({ kind: "allow" });
  });

  it("does not let a workflow launder a sign-off through an approver of its own choosing", async () => {
    // Under the "each" policy: a publish needs marketing-lead's approval covering it.
    const runId = await c().start(launder, { text: "trust me" }, { startedBy: { id: "each" } });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "intern" } });

    // The intern's approval covers the post, but was not addressed to marketing-lead.
    await waitFor(pending(c, runId, 2));
    expect((await c().approvals(runId))[1]).toMatchObject({
      approver: "marketing-lead",
      requestedBy: "policy",
      op: "bluesky.post.create",
      status: "pending",
    });
    expect(app.ops()).toEqual([]);
    expect(ofType(await c().ledger(runId), "approval.requested")[0]).toMatchObject({
      approver: "intern",
      requestedBy: "workflow",
      covers: ["bluesky.post.create"],
    });

    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect(app.ops()).toEqual(["bluesky.post.create"]);
  });

  it("lets anyone in an approver group decide, and refuses anyone outside it", async () => {
    const runId = await c().start(shout, { text: "hello" }, { startedBy: { id: "group" } });
    await waitFor(pending(c, runId));
    expect((await c().approvals(runId))[0]).toMatchObject({
      title: "bluesky.post.create needs group marketing",
      approver: { group: "marketing" },
    });

    const outsider = { id: "bob", groups: ["sales"] };
    const wrong = await caught(c().decide(runId, { decision: "approve", by: outsider }));
    expect(errorCode(wrong)).toBe("not_approver");
    expect(wrong).toMatchObject({
      message: "bob is not in group marketing (approval-1)",
      data: { approvalId: "approval-1", approver: { group: "marketing" } },
    });
    // A person whose id is the group's name is not in it.
    await app.raw.send(runId, { decision: "approve", by: outsider }, "approval-1");
    await app.raw.send(runId, { decision: "approve", by: { id: "marketing" } }, "approval-1");
    await waitFor(async () => (await c().approvals(runId))[0]?.refused.length === 2);
    expect((await c().approvals(runId))[0]?.refused.map((r) => r.reason)).toEqual([
      "bob is not in group marketing",
      "marketing is not in group marketing",
    ]);
    expect(app.ops()).toEqual([]);

    const decided = await c().decide(runId, { decision: "approve", by: { id: "carol", groups: ["marketing"] } });
    expect(decided).toMatchObject({ status: "approved", decidedBy: "carol" });
    await c().result(runId);
    expect(app.ops()).toEqual(["bluesky.post.create"]);
    const records = await c().ledger(runId);
    expect(ofType(records, "approval.requested")[0]).toMatchObject({ approver: { group: "marketing" } });
    expect(ofType(records, "approval.decided")[0]).toMatchObject({ by: "carol" });
  });

  it("tells the loser of two decisions sent at once that it was already decided, by whom", async () => {
    const runId = await c().start(shout, { text: "race" }, { startedBy: { id: "group" } });
    await waitFor(pending(c, runId));

    const people = ["carol", "dave"].map((id) => ({ id, groups: ["marketing"] }));
    const outcomes = await Promise.allSettled(
      people.map((by) => c().decide(runId, { decision: "approve", by }, "approval-1")),
    );
    const won = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
    const lost = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(errorCode(lost[0])).toBe("already_decided");
    expect(lost[0]).toMatchObject({ data: { status: "approved", decidedBy: won[0]?.decidedBy } });
    expect((await c().approvals(runId))[0]?.decidedBy).toBe(won[0]?.decidedBy);
    await c().result(runId);
  });

  it("tells the loser of two decisions from one person, the same verdict with different notes, that it lost", async () => {
    const runId = await c().start(shout, { text: "twice" }, { startedBy: { id: "group" } });
    await waitFor(pending(c, runId));

    const carol = { id: "carol", groups: ["marketing"] };
    const outcomes = await Promise.allSettled(
      ["first", "second"].map((note) => c().decide(runId, { decision: "approve", by: carol, note }, "approval-1")),
    );
    const won = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
    const lost = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
    expect(won).toHaveLength(1);
    expect(errorCode(lost[0])).toBe("already_decided");
    expect((await c().approvals(runId))[0]).toMatchObject({ decidedBy: "carol", note: won[0]?.note });
    await c().result(runId);
  });
});
