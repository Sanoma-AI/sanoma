import { randomUUID } from "node:crypto";
import { bluesky } from "@sanoma/connector-bluesky";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  approve,
  type ApprovalState,
  decisionEventOf,
  definePolicy,
  defineWorkflow,
  errorCode,
  type LedgerRecord,
  mayDecide,
  type Policy,
  type PolicyCall,
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

/** One post, which the "group" policy holds for the marketing group. */
const shout = defineWorkflow({
  name: "shout",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
  run: async (ctx, { text }) => ctx.bluesky.post.create({ text }),
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
  const app = useApp(databaseUrl, "approvals");
  const c = () => app.client;

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
    expect(errorCode(none)).toBe("no_pending_approval");
    expect(app.ops()).toHaveLength(5);
  });

  it("says run_not_found for a decision on a run that does not exist", async () => {
    const missing = randomUUID();
    const err = await caught(c().decide(missing, { decision: "approve", by: lead }, "approval-1"));
    expect(errorCode(err)).toBe("run_not_found");
    expect(err).toMatchObject({ message: `No run ${missing}`, data: { runId: missing } });
  });
});

/** True when an approval that covers the call's operation is approved: the README's check. */
const approved = ({ op, run }: PolicyCall) =>
  run.approvals.some((a) => a.status === "approved" && a.covers.includes(op.id));

describe("approvals a policy asks for", () => {
  // The test picks a policy per run by actor.
  const byActor: Record<string, Policy> = {
    // The README's policy: each publishing operation needs an approval that covers it.
    each: (call) => (call.effect === "publish" && !approved(call) ? approve("marketing-lead") : allow()),
    broad: (call) =>
      call.effect === "publish" && !approved(call)
        ? approve("marketing-lead", { title: "Publish everywhere", covers: [bluesky.post.create] })
        : allow(),
    group: (call) => (approved(call) ? allow() : approve({ group: "marketing" })),
  };
  const policy = definePolicy((call) => byActor[call.actor.id]?.(call) ?? allow());
  const app = useApp(databaseUrl, "approvals-policy", () => ({ workflows: [announce, shout], policy }));
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
