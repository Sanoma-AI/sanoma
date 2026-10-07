import { randomUUID } from "node:crypto";
import { bluesky } from "@sanoma/connector-bluesky";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  approve,
  type Decision,
  definePolicy,
  defineWorkflow,
  deny,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  type Policy,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("announce");
const alice = { id: "alice", groups: ["marketing"] };
const types = (records: LedgerRecord[]) => records.map((r) => (r.type === "op.called" ? `${r.type} ${r.op}` : r.type));

/** Posts twice at once, so a policy that holds each call has two approvals pending together. */
const twin = defineWorkflow({
  name: "twin",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create],
  run: async (ctx) => Promise.all(["one", "two"].map((text) => ctx.bluesky.post.create({ text }))),
});

describe("announce", () => {
  const app = useApp(databaseUrl, "announce");
  const c = () => app.client;

  it("drafts, waits for the named approver, sleeps until launch, then publishes", async () => {
    const launchAt = inSeconds(3);
    const runId = await c().start(
      announce,
      { title: "Acme Pro is here", body: "<p>Hello</p>", launchAt },
      { runId: randomUUID(), startedBy: alice },
    );

    await waitFor(pending(c, runId));
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect(Object.values(app.vendors.state.posts)[0]?.status).toBe("draft");
    expect((await c().run(runId))?.status).toBe("waiting");

    await expect(c().decide(runId, { decision: "approve", by: { id: "intern" } })).rejects.toThrow(
      '"intern" is not the approver for approval-1; marketing-lead is',
    );
    await app.raw.send(runId, { decision: "approve", by: { id: "intern" } }, "approval-1");
    await waitFor(async () => (await c().approvals(runId))[0]?.refused.length === 1);
    expect((await c().approvals(runId))[0]?.status).toBe("pending");
    expect(app.ops()).toHaveLength(2);

    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" }, note: "ship it" });
    const result = (await c().result(runId)) as { post: string; social: string };

    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(launchAt));
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "ghost.post.publish",
      "resend.broadcast.send",
      "bluesky.post.create",
    ]);
    expect(result.post).toBe("https://blog.example.test/acme-pro-is-here/");
    expect(app.vendors.state.social[0]?.text).toBe("Acme Pro is here https://blog.example.test/acme-pro-is-here/");
    const [approval] = await c().approvals(runId);
    expect(approval).toMatchObject({ status: "approved", decidedBy: "marketing-lead", note: "ship it" });
    expect((await c().run(runId))?.status).toBe("finished");
  });

  it("records the run in the ledger, in order, as the person who started it, under allowAll", async () => {
    const runId = await c().start(
      announce,
      { title: "Ledger", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: alice },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "approval.requested",
      "approval.decided",
      "op.called ghost.post.publish",
      "op.called resend.broadcast.send",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    for (const r of records) expect(r).toMatchObject({ v: 1, app: "announce", runId, actor: alice });
    const decisions = records.flatMap((r) => (r.type === "op.called" ? [r.decision] : []));
    expect(decisions).toEqual(Array.from({ length: 5 }, () => ({ kind: "allow" })));
    expect(records[0]).toMatchObject({ type: "run.started", workflow: "announce", input: { title: "Ledger" } });
    expect(records[3]).toMatchObject({ approval: "approval-1", approver: "marketing-lead" });
    expect(records[4]).toMatchObject({ approval: "approval-1", decision: "approve", by: "marketing-lead" });
    expect(records.at(-1)).toMatchObject({ type: "run.finished", output: { post: expect.any(String) } });
    // Rebuilt from DBOS's authenticated user and roles.
    expect((await c().run(runId))?.startedBy).toEqual(alice);
  });

  it("finishes after the worker is stopped and restarted mid-sleep, without repeating a step", async () => {
    const launchAt = inSeconds(4);
    const runId = await c().start(announce, { title: "Restart", body: "<p>x</p>", launchAt }, { startedBy: alice });
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await waitFor(async () => (await c().approvals(runId))[0]?.status === "approved");

    await app.worker.stop();
    expect(app.ops()).not.toContain("ghost.post.publish");
    await app.restart();

    await c().result(runId);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(launchAt));
    const counts = Object.groupBy(app.ops(), (op) => op);
    for (const op of Object.keys(counts)) expect(counts[op], op).toHaveLength(1);
    expect(Object.keys(counts)).toHaveLength(5);

    // The replay wrote run.started and the approval records again; the ledger kept one of each.
    const records = await c().ledger(runId);
    const kinds = Object.groupBy(types(records), (t) => t);
    expect(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v?.length]))).toEqual({
      "run.started": 1,
      "op.called ghost.post.create": 1,
      "op.called resend.broadcast.create": 1,
      "approval.requested": 1,
      "approval.decided": 1,
      "op.called ghost.post.publish": 1,
      "op.called resend.broadcast.send": 1,
      "op.called bluesky.post.create": 1,
      "run.finished": 1,
    });
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    expect(types(records)).not.toContain("run.failed");
  });

  it("ignores a message that is not a decision, records it, and keeps waiting", async () => {
    const runId = await c().start(
      announce,
      { title: "Garbled", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: alice },
    );
    await waitFor(pending(c, runId));

    await app.raw.send(runId, { decision: "yes please", by: { id: "marketing-lead" } }, "approval-1");
    await app.raw.send(runId, "approve", "approval-1");
    await waitFor(async () => (await c().approvals(runId))[0]?.refused.length === 2);
    const [approval] = await c().approvals(runId);
    expect(approval).toMatchObject({ status: "pending", requestedBy: "workflow" });
    expect(approval?.refused).toEqual([
      { by: "marketing-lead", at: expect.any(Number), reason: "not a valid decision message" },
      { at: expect.any(Number), reason: "not a valid decision message" },
    ]);
    expect(app.ops()).toHaveLength(2);

    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);
    const records = await c().ledger(runId);
    expect(records.filter((r) => r.type === "approval.refused")).toEqual([
      expect.objectContaining({ id: `${runId}:approval.refused:approval-1:refused:1`, by: "marketing-lead" }),
      expect.objectContaining({ id: `${runId}:approval.refused:approval-1:refused:2`, reason: expect.any(String) }),
    ]);
    expect(records.at(-1)?.type).toBe("run.finished");
  });

  it("stops before publishing anything when the approver rejects", async () => {
    const runId = await c().start(
      announce,
      { title: "Nope", body: "<p>x</p>", launchAt: inSeconds(1) },
      { runId: randomUUID(), startedBy: alice },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "reject", by: { id: "marketing-lead" }, note: "wrong date" });

    const err = await c()
      .result(runId)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringMatching(/rejected by marketing-lead: wrong date/) });
    expect(errorCode(err)).toBe("approval_rejected");
    expect(err).toMatchObject({
      data: { title: "Review launch copy", by: { id: "marketing-lead" }, note: "wrong date", approvalId: "approval-1" },
    });
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect((await c().run(runId))?.status).toBe("failed");
    const records = await c().ledger(runId);
    expect(records.at(-2)).toMatchObject({ type: "approval.decided", decision: "reject", note: "wrong date" });
    expect(records.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "approval_rejected", name: "RejectedError", message: expect.stringMatching(/rejected/) },
    });
  });
});

describe("announce under a policy", () => {
  // Deterministic: each decision depends on the call alone. The test picks a policy per run by actor.
  const byActor: Record<string, Policy> = {
    "no-email": ({ effect }) => (effect === "send" ? deny("no email this week") : allow()),
    "lead-publishes": ({ effect, run }) =>
      effect === "publish" && !run.approvals.some((a) => a.approver === "marketing-lead" && a.status === "approved")
        ? approve("marketing-lead")
        : allow(),
    "approve-nobody": ({ effect }) => (effect === "publish" ? ({ kind: "approve" } as unknown as Decision) : allow()),
    "hold-each": ({ op, input, run }) =>
      run.approvals.some(
        (a) =>
          a.requestedBy === "policy" &&
          a.op === op.id &&
          a.status === "approved" &&
          JSON.stringify(a.input) === JSON.stringify(input),
      )
        ? allow()
        : approve("lead"),
  };
  const policy = definePolicy((call) => byActor[call.actor.id]?.(call) ?? allow());
  const app = useApp(databaseUrl, "announce-policy", () => ({
    workflows: [announce, twin],
    policy,
    ledger: memoryLedger(),
  }));
  const c = () => app.client;

  it("fails the run when the policy denies a call, records the denial, and keeps the code through DBOS", async () => {
    const runId = await c().start(
      announce,
      { title: "Denied", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: { id: "no-email" } },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });

    const err = await c()
      .result(runId)
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("policy_denied");
    expect(err).toMatchObject({
      message: "resend.broadcast.send was denied by policy: no email this week",
      data: { op: "resend.broadcast.send", reason: "no email this week" },
    });
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create", "ghost.post.publish"]);
    expect(Object.values(app.vendors.state.broadcasts).map((b) => b.status)).toEqual(["draft"]);

    const records = await c().ledger(runId);
    const denied = {
      code: "policy_denied",
      name: "PolicyDeniedError",
      message: expect.stringMatching(/denied by policy/),
    };
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "resend.broadcast.send",
      effect: "send",
      decision: { kind: "deny", reason: "no email this week" },
      error: denied,
    });
    expect(records.at(-2)).not.toHaveProperty("output");
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: denied });
  });

  it("holds a call for the approver the policy names, ignoring anyone else", async () => {
    const runId = await c().start(
      announce,
      { title: "Held", body: "<p>x</p>", launchAt: inSeconds(1), approver: "editor" },
      { startedBy: { id: "lead-publishes" } },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "editor" } });

    await waitFor(pending(c, runId, 2));
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    const held = (await c().approvals(runId))[1];
    expect(held).toMatchObject({ title: "ghost.post.publish needs marketing-lead", approver: "marketing-lead" });

    await app.raw.send(runId, { decision: "approve", by: { id: "intern" } }, "approval-2");
    await waitFor(async () => (await c().approvals(runId))[1]?.refused.length === 1);
    expect((await c().approvals(runId))[1]?.status).toBe("pending");
    expect(app.ops()).toHaveLength(2);

    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);
    expect(app.ops()).toHaveLength(5);

    const records = await c().ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "approval.requested",
      "approval.decided",
      "approval.requested",
      "approval.refused",
      "approval.decided",
      "op.called ghost.post.publish",
      "op.called resend.broadcast.send",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(records[5]).toMatchObject({ approval: "approval-2", requestedBy: "policy", op: "ghost.post.publish" });
    expect(records[6]).toMatchObject({ approval: "approval-2", by: "intern", reason: "intern is not the approver" });
    expect(records[7]).toMatchObject({ approval: "approval-2", by: "marketing-lead" });
    expect(records[8]).toMatchObject({ decision: { kind: "approve", approver: "marketing-lead" }, attempt: 1 });
    expect(records[10]).toMatchObject({ op: "bluesky.post.create", decision: { kind: "allow" } });
  });

  it("records the held call as stopped when the policy's approver rejects it", async () => {
    const runId = await c().start(
      announce,
      { title: "Held, then rejected", body: "<p>x</p>", launchAt: inSeconds(1), approver: "editor" },
      { startedBy: { id: "lead-publishes" } },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "editor" } });
    await waitFor(pending(c, runId, 2));
    expect((await c().approvals(runId))[1]).toMatchObject({
      requestedBy: "policy",
      op: "ghost.post.publish",
      input: { id: expect.any(String) },
    });
    await c().decide(runId, { decision: "reject", by: { id: "marketing-lead" }, note: "not today" });

    await expect(c().result(runId)).rejects.toThrow(/rejected by marketing-lead: not today/);
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    const records = await c().ledger(runId);
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "ghost.post.publish",
      decision: { kind: "approve", approver: "marketing-lead" },
      approval: "approval-2",
      error: { code: "approval_rejected", message: expect.stringMatching(/rejected by marketing-lead/) },
    });
    expect(records.at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("fails the run, naming the operation, when the policy returns a malformed decision", async () => {
    const runId = await c().start(
      announce,
      { title: "Malformed", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: { id: "approve-nobody" } },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });

    await expect(c().result(runId)).rejects.toThrow(
      'The policy returned {"kind":"approve"} for ghost.post.publish: approve needs an approver',
    );
    expect(app.ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect((await c().ledger(runId)).at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("gives calls held at the same time their own approvals", async () => {
    const runId = await c().start(twin, {}, { startedBy: { id: "hold-each" } });
    await waitFor(async () => (await c().approvals(runId)).filter((a) => a.status === "pending").length === 2);
    const held = await c().approvals(runId);
    expect(held.map((a) => a.id)).toEqual(["approval-1", "approval-2"]);
    expect(held.map((a) => (a.input as { text: string }).text).toSorted()).toEqual(["one", "two"]);
    expect(app.ops()).toEqual([]);

    await c().decide(runId, { decision: "approve", by: { id: "lead" } }, "approval-2");
    await c().decide(runId, { decision: "approve", by: { id: "lead" } }, "approval-1");
    await c().result(runId);
    expect(app.vendors.state.social.map((p) => p.text).toSorted()).toEqual(["one", "two"]);
  });

  it("does not wait again when the approver already approved earlier in the run", async () => {
    const runId = await c().start(
      announce,
      { title: "Once", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: { id: "lead-publishes" } },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });
    await c().result(runId);

    expect(await c().approvals(runId)).toHaveLength(1);
    expect(app.ops()).toHaveLength(5);
    const decisions = (await c().ledger(runId)).flatMap((r) => (r.type === "op.called" ? [r.decision.kind] : []));
    expect(decisions).toEqual(["allow", "allow", "allow", "allow", "allow"]);
  });
});

describe("announce with a vendor that replies off-contract", () => {
  let publishes = 0;
  const app = useApp(databaseUrl, "announce-off-contract", (vendors) => ({
    drivers: vendors.drivers.map((d) =>
      d.vendor === "ghost"
        ? {
            ...d,
            ops: {
              ...d.ops,
              "post.publish": async () => {
                publishes++;
                return { id: 42 };
              },
            },
          }
        : d,
    ),
  }));
  const c = () => app.client;

  it("does not retry an idempotent call whose reply fails the output schema", async () => {
    const runId = await c().start(
      announce,
      { title: "Off contract", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: alice },
    );
    await waitFor(pending(c, runId));
    await c().decide(runId, { decision: "approve", by: { id: "marketing-lead" } });

    await expect(c().result(runId)).rejects.toThrow(/expected string/i);
    expect(publishes).toBe(1);
    const records = await c().ledger(runId);
    expect(records.at(-2)).toMatchObject({ type: "op.called", op: "ghost.post.publish", attempt: 1 });
    expect(records.at(-2)).not.toHaveProperty("output");
    expect(records.at(-1)).toMatchObject({ type: "run.failed" });
  });
});
