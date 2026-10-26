import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bluesky } from "@sanoma-ai/connector-bluesky";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { messageKeyOf, topicOf, withdrawApprovals } from "../src/approvals.ts";
import {
  approvedFor,
  type ApprovalState,
  decisionEventOf,
  defineWorkflow,
  errorCode,
  type LedgerRecord,
  mayDecide,
} from "../src/index.ts";
import { sanoma } from "../src/constructors.ts";
import { currentRun } from "../src/run.ts";
import { OWN_CHANGE, type PeopleResource, refusalOf } from "../src/shared.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, rootWith, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
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

/**
 * A post signed off by marketing-lead, whose sign-off the run then withdraws, as a change does on
 * a new commit: the post is held again rather than let through by the old approval.
 */
const resign = defineWorkflow({
  name: "resign",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create, "approval"],
  run: async (ctx, { text }) => {
    await ctx.approval("Sign off", { approver: "marketing-lead", covers: [bluesky.post.create] });
    await withdrawApprovals(currentRun.getStore()!, "bluesky.post.create", "a new commit");
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
    expect(approvedFor([state({ status: "withdrawn", withdrawnReason: "a new commit" })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ covers: [] })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ covers: ["shop.order.get"] })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ approver: "intern" })], refund, "lead")).toBe(false);
    // A person and a group of the same name are different approvers.
    expect(approvedFor([state({ approver: { group: "lead" } })], refund, "lead")).toBe(false);
    expect(approvedFor([state({ approver: "lead" })], refund, { group: "lead" })).toBe(false);
    expect(approvedFor([state({ approver: { group: "sales" } })], refund, { group: "finance" })).toBe(false);
  });
});

/** The people as the data files declare them: ada, carol and dave, these agents, and each group by name, of its members' ids. */
const declared = (groups: Record<string, string[]>, agents: string[] = []): PeopleResource[] => [
  ...["ada", "carol", "dave"].map((id) => sanoma.person({ id })),
  ...agents.map((id) => sanoma.agent({ id })),
  ...Object.entries(groups).map(([name, members]) => sanoma.group({ name, members })),
];

describe("mayDecide", () => {
  const run = { actor: { id: "ada" } };
  const marketing = declared({ marketing: ["ada", "carol"] });

  it("matches a named approver by id, and a group approver by the principal's groups", () => {
    expect(mayDecide({ approver: "lead" }, { id: "lead" }, run, marketing)).toBe(true);
    expect(mayDecide({ approver: "lead" }, { id: "intern", groups: ["lead"] }, run, marketing)).toBe(false);
    const group = { approver: { group: "marketing" } };
    expect(mayDecide(group, { id: "carol", groups: ["ops", "marketing"] }, run, marketing)).toBe(true);
    expect(mayDecide(group, { id: "marketing" }, run, marketing)).toBe(false);
    expect(mayDecide(group, { id: "bob", groups: [] }, run, marketing)).toBe(false);
  });

  it("refuses the run's own actor while someone else in the group could decide, and says why; an agent's person may decide", () => {
    const own = { approver: { group: "marketing" } };
    expect(mayDecide(own, { id: "ada", groups: ["marketing"] }, run, marketing)).toBe(false);
    expect(refusalOf(own, { id: "ada", groups: ["marketing"] }, run, marketing)).toBe(OWN_CHANGE);
    expect(refusalOf(own, { id: "ada" }, run, marketing)).toBe("ada is not in group marketing");
    expect(mayDecide({ approver: "bo" }, { id: "bo" }, { actor: { id: "refund-bot" } }, [])).toBe(true);
    expect(mayDecide({ approver: "bo" }, { id: "bo" }, {}, [])).toBe(true);
  });

  it("lets the run's own actor decide when nobody else could: named, alone in the group, or with no other declared agent", () => {
    const own = { approver: { group: "marketing" } };
    const ada = { id: "ada", groups: ["marketing"] };
    expect(mayDecide({ approver: "ada" }, { id: "ada" }, run, marketing)).toBe(true);
    expect(mayDecide(own, ada, run, declared({ marketing: ["ada"] }))).toBe(true);
    // A second member joining flips it.
    expect(refusalOf(own, ada, run, declared({ marketing: ["ada", "dave"] }))).toBe(OWN_CHANGE);
    // Only another person counts: an agent in the group, or in `agents`, does not.
    expect(mayDecide(own, ada, run, declared({ marketing: ["ada", "bot"] }, ["bot"]))).toBe(true);
    const bot = { id: "bot", groups: ["agents"] };
    const agents = { approver: { group: "agents" } };
    expect(mayDecide(agents, bot, { actor: bot }, declared({}, ["bot", "other-bot"]))).toBe(true);
  });
});

describe("approvals a workflow asks for", () => {
  const app = useApp("approvals", () => ({ workflows: [announce, odd] }));
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
      await app.raw.send(
        runId,
        { id: "m-1", decision: "approve", by: lead },
        topicOf("approval-1"),
        messageKeyOf("approval-1", "m-1"),
      );
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

  it("says not_approver, rather than still pending, when the run read the decision and refused it", async () => {
    const runId = await c().start(announce, input("Refused in the run"), { startedBy: alice });
    await waitFor(pending(c, runId));
    // A message the run refuses, sent around the client under the id and key decide then uses:
    // decide's own send is that message, which the run has read and refused.
    const message = { id: "m-9", decision: "approve" as const, by: { id: "intern" } };
    await app.raw.send(runId, message, topicOf("approval-1"), messageKeyOf("approval-1", "m-9"));
    await waitFor(async () => (await c().approvals(runId))[0]?.refused[0]?.id === "m-9");

    const err = await caught(c().decide(runId, { ...message, by: lead }, undefined, { timeoutSeconds: 1 }));
    expect(errorCode(err)).toBe("not_approver");
    expect(err).toMatchObject({
      message: "intern is not the approver; marketing-lead is (approval-1)",
      data: { runId, approvalId: "approval-1", approver: "marketing-lead" },
    });
    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
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

  it("lets the run's starter decide an approval that names them, and records that nobody else could", async () => {
    const runId = await c().start(odd, { request: { approver: "alice" } }, { startedBy: alice });
    await waitFor(pending(c, runId));

    expect(await c().decide(runId, { decision: "approve", by: alice })).toMatchObject({
      status: "approved",
      decidedBy: "alice",
      alone: true,
    });
    expect(await c().result(runId)).toMatchObject({ approvedBy: "alice" });
    expect(ofType(await c().ledger(runId), "approval.decided")).toEqual([
      expect.objectContaining({ by: "alice", alone: true }),
    ]);
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

  it("withdraws a pending approval: the run fails with approval_withdrawn, records it, and takes no decision after", async () => {
    const runId = await c().start(announce, input("Withdrawn"), { startedBy: alice });
    await waitFor(pending(c, runId));

    const withdrawn = await c().withdraw(runId, "approval-1", "a new commit", { by: alice });
    expect(withdrawn).toMatchObject({
      id: "approval-1",
      status: "withdrawn",
      withdrawnReason: "a new commit",
      withdrawnAt: expect.any(Number),
      withdrawnBy: "alice",
      decidedWith: expect.any(String),
    });
    expect(withdrawn).not.toHaveProperty("decidedBy");
    expect(withdrawn).not.toHaveProperty("decidedAt");
    // The list, then the decision event: both say so.
    expect((await c().approvals(runId))[0]).toEqual(withdrawn);
    expect(await app.raw.getEvent<ApprovalState>(runId, decisionEventOf("approval-1"), 0)).toEqual(withdrawn);
    expect(approvedFor(await c().approvals(runId), "ghost.post.publish", "marketing-lead")).toBe(false);

    const err = await caught(c().result(runId));
    expect(errorCode(err)).toBe("approval_withdrawn");
    expect(err).toMatchObject({ data: { approvalId: "approval-1", reason: "a new commit" } });
    const records = await c().ledger(runId);
    expect(ofType(records, "approval.withdrawn")).toEqual([
      expect.objectContaining({
        id: `${runId}:approval.withdrawn:approval-1`,
        approval: "approval-1",
        by: "alice",
        reason: "a new commit",
      }),
    ]);
    expect(ofType(records, "approval.decided")).toEqual([]);

    const late = await caught(c().decide(runId, { decision: "approve", by: lead }, "approval-1"));
    expect(errorCode(late)).toBe("already_decided");
    expect(late).toMatchObject({
      message: `approval-1 on run ${runId} was already withdrawn: a new commit`,
      data: { status: "withdrawn", withdrawnReason: "a new commit" },
    });
    const again = await caught(c().withdraw(runId, "approval-1", "another commit", { by: alice }));
    expect(errorCode(again)).toBe("already_decided");
  });

  it("lets the starter or the approver withdraw, and refuses anyone else as not_approver", async () => {
    const runId = await c().start(announce, input("Withdrawn by whom"), { startedBy: alice });
    await waitFor(pending(c, runId));

    const stranger = await caught(c().withdraw(runId, "approval-1", "mine now", { by: "intern" }));
    expect(errorCode(stranger)).toBe("not_approver");
    expect(stranger).toMatchObject({
      message: "intern is not the approver; marketing-lead is (approval-1)",
      data: { runId, approvalId: "approval-1", approver: "marketing-lead" },
    });
    const visitor = await caught(c().withdraw(runId, "approval-1", "no", { by: "anonymous" }));
    expect(errorCode(visitor)).toBe("not_approver");
    const blank = await caught(c().withdraw(runId, "approval-1", "", { by: alice }));
    expect(errorCode(blank)).toBe("invalid_input");
    expect((await c().approvals(runId))[0]).toMatchObject({ status: "pending", refused: [] });

    // Sent around the client's check: the run checks who withdraws too, and records the refusal.
    await app.raw.send(runId, { withdraw: "mine now", by: { id: "intern" }, id: "w-1" }, topicOf("approval-1"));
    await waitFor(async () => (await c().approvals(runId))[0]?.refused.length === 1);
    expect((await c().approvals(runId))[0]).toMatchObject({
      status: "pending",
      refused: [{ by: "intern", id: "w-1", reason: "intern is not the approver; marketing-lead is" }],
    });
    expect(ofType(await c().ledger(runId), "approval.refused")).toEqual([
      expect.objectContaining({ by: "intern", reason: "intern is not the approver; marketing-lead is" }),
    ]);

    expect(await c().withdraw(runId, "approval-1", "not needed", { by: lead })).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "not needed",
    });
    expect(errorCode(await caught(c().result(runId)))).toBe("approval_withdrawn");
  });

  it("says run_not_found for a decision on a run that does not exist", async () => {
    const missing = randomUUID();
    const err = await caught(c().decide(missing, { decision: "approve", by: lead }, "approval-1"));
    expect(errorCode(err)).toBe("run_not_found");
    expect(err).toMatchObject({ message: `No run ${missing}`, data: { runId: missing } });
  });
});

describe("approvals a policy asks for", () => {
  // The test picks a rule per run by who starts it: each Cedar policy names its principal.
  const peopleFile = `import { sanoma } from "sanoma/resources";

export const each = sanoma.person({ id: "each" });
export const group = sanoma.person({ id: "group" });
export const lead = sanoma.person({ id: "marketing-lead" });
export const intern = sanoma.person({ id: "intern" });
export const bob = sanoma.person({ id: "bob" });
export const carol = sanoma.person({ id: "carol" });
export const dave = sanoma.person({ id: "dave" });
export const solo = sanoma.person({ id: "solo" });
export const helper = sanoma.agent({ id: "helper" });
export const marketing = sanoma.group({ name: "marketing", members: [carol, dave] });
export const sales = sanoma.group({ name: "sales", members: [bob] });
export const solos = sanoma.group({ name: "solos", members: [solo, helper] });
`;
  const root = rootWith({
    "resources/people.ts": peopleFile,
    "policies/policy.cedar": `// The README's policy: each publishing operation needs marketing-lead's approval.
@hold("marketing-lead")
forbid (principal == Sanoma::Principal::"each", action in Sanoma::Action::"effect:publish", resource);

@hold("marketing")
forbid (principal == Sanoma::Principal::"group", action == Sanoma::Action::"bluesky.post.create", resource);

@hold("solos")
forbid (principal == Sanoma::Principal::"solo", action == Sanoma::Action::"bluesky.post.create", resource);
`,
  });
  const app = useApp("approvals-policy", () => ({ workflows: [announce, shout, launder, resign], root }));
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
    // Each request names its step: the workflow's approval by its title, the policy's hold by the held call's name.
    expect(ofType(await c().ledger(runId), "approval.requested")).toMatchObject([
      { approver: "intern", requestedBy: "workflow", covers: ["bluesky.post.create"], name: "Looks fine", node: "0" },
      { approver: "marketing-lead", requestedBy: "policy", name: "bluesky.post.create", node: "1" },
    ]);

    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect(app.ops()).toEqual(["bluesky.post.create"]);
  });

  it("retires an approval the run withdraws, so it lifts no hold, and records a held call's withdrawal as its failure", async () => {
    const runId = await c().start(resign, { text: "v2" }, { startedBy: { id: "each" } });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: lead });

    // The sign-off covered the post and was addressed to marketing-lead, but no longer stands.
    await waitFor(pending(c, runId, 2));
    const [signOff, hold] = await c().approvals(runId);
    expect(signOff).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "a new commit",
      withdrawnAt: expect.any(Number),
      decidedBy: "marketing-lead",
    });
    expect(signOff).not.toHaveProperty("withdrawnBy");
    expect(hold).toMatchObject({ requestedBy: "policy", op: "bluesky.post.create", status: "pending" });
    expect(approvedFor([signOff!], "bluesky.post.create", "marketing-lead")).toBe(false);
    expect(await app.raw.getEvent<ApprovalState>(runId, decisionEventOf("approval-1"), 0)).toEqual(signOff);
    expect(app.ops()).toEqual([]);

    // A replay withdraws it again in step, writing nothing twice.
    await app.restart();
    await c().withdraw(runId, "approval-2", "another commit", { by: { id: "each" } });
    expect(errorCode(await caught(c().result(runId)))).toBe("approval_withdrawn");
    expect(app.ops()).toEqual([]);

    const records = await c().ledger(runId);
    expect(ofType(records, "approval.withdrawn")).toEqual([
      expect.objectContaining({ approval: "approval-1", reason: "a new commit" }),
      expect.objectContaining({ approval: "approval-2", by: "each", reason: "another commit" }),
    ]);
    expect(ofType(records, "op.called")).toEqual([
      expect.objectContaining({
        op: "bluesky.post.create",
        approval: "approval-2",
        error: expect.objectContaining({ code: "approval_withdrawn" }),
      }),
    ]);
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

    const decided = await c().decide(runId, { decision: "approve", by: { id: "carol" } });
    expect(decided).toMatchObject({ status: "approved", decidedBy: "carol" });
    await c().result(runId);
    expect(app.ops()).toEqual(["bluesky.post.create"]);
    const records = await c().ledger(runId);
    expect(ofType(records, "approval.requested")[0]).toMatchObject({ approver: { group: "marketing" } });
    expect(ofType(records, "approval.decided")[0]).toMatchObject({ by: "carol" });
  });

  it("lets the starter decide with only an agent beside them in the approver group, and refuses them once a person joins it", async () => {
    const solo = { id: "solo" };
    const first = await c().start(shout, { text: "alone" }, { startedBy: solo });
    await waitFor(pending(c, first));
    expect(await c().decide(first, { decision: "approve", by: solo })).toMatchObject({
      status: "approved",
      decidedBy: "solo",
      alone: true,
    });
    await c().result(first);
    expect(ofType(await c().ledger(first), "approval.decided")).toEqual([
      expect.objectContaining({ by: "solo", alone: true }),
    ]);

    // bob joins the group: now someone else could decide, so the starter may not, in the client or the run.
    const file = join(root, "resources/people.ts");
    writeFileSync(file, peopleFile.replace("members: [solo, helper]", "members: [solo, helper, bob]"));
    try {
      const second = await c().start(shout, { text: "not alone" }, { startedBy: solo });
      await waitFor(pending(c, second));
      const own = await caught(c().decide(second, { decision: "approve", by: solo }));
      expect(own).toMatchObject({ message: "own change (approval-1)", data: { reason: OWN_CHANGE } });
      await app.raw.send(second, { decision: "approve", by: { id: "solo", groups: ["solos"] } }, "approval-1");
      await waitFor(async () => (await c().approvals(second))[0]?.refused.length === 1);
      expect((await c().approvals(second))[0]?.refused[0]).toMatchObject({ by: "solo", reason: OWN_CHANGE });

      const decided = await c().decide(second, { decision: "approve", by: { id: "bob" } });
      expect(decided).toMatchObject({ status: "approved", decidedBy: "bob" });
      expect(decided).not.toHaveProperty("alone");
      await c().result(second);
    } finally {
      writeFileSync(file, peopleFile);
    }
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
