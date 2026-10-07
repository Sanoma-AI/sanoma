import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeMarketingVendors } from "@sanoma/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  allow,
  approve,
  type Decision,
  definePolicy,
  defineWorkflow,
  deny,
  jsonlLedger,
  type LedgerRecord,
  memoryLedger,
  type Policy,
  SanomaClient,
  startWorker,
  type Worker,
  type WorkerOptions,
} from "../src/index.ts";
import announce from "./fixtures/announce.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = process.env.SANOMA_TEST_DATABASE_URL ?? "postgresql://postgres:dbos@localhost:5433/sanoma_test";
const appName = "sanoma-test";
const vendors = fakeMarketingVendors();
// On disk, so the ledger outlives a worker restart the way it would across processes.
const ledgerDir = mkdtempSync(join(tmpdir(), "sanoma-ledger-"));
const ledger = jsonlLedger(ledgerDir);
let worker: Worker;
let client: SanomaClient;
// Sends messages the way any process with database access could, without SanomaClient's checks.
let raw: DBOSClient;

/** Posts twice at once, so a policy that holds each call has two approvals pending together. */
const twin = defineWorkflow({
  name: "twin",
  trigger: "manual",
  input: z.object({}),
  uses: [bluesky.post.create],
  run: async (ctx) => Promise.all(["one", "two"].map((text) => ctx.bluesky.post.create({ text }))),
});

// Every worker registers the same workflows. DBOS versions an app by its registered
// workflows, and only a worker on the latest version takes runs from the queue.
const start = (options: Partial<WorkerOptions> = {}) =>
  startWorker({
    workflows: [announce, twin],
    connectors: [ghost, resend, bluesky],
    drivers: vendors.drivers,
    databaseUrl,
    appName,
    ledger,
    ...options,
  });
const ops = () => vendors.state.calls.map((c) => c.op);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const types = (records: LedgerRecord[]) => records.map((r) => (r.type === "op.called" ? `${r.type} ${r.op}` : r.type));

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pending =
  (runId: string, count = 1, c = () => client) =>
  async () =>
    (await c().approvals(runId)).filter((a) => a.status === "pending").length === 1 &&
    (await c().approvals(runId)).length === count;

beforeAll(async () => {
  worker = await start();
  client = await SanomaClient.connect(databaseUrl, { appName, ledger });
  raw = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, applicationName: appName });
});

afterAll(async () => {
  await client?.close();
  await raw?.destroy();
  await worker?.stop();
  rmSync(ledgerDir, { recursive: true, force: true });
});

beforeEach(() => vendors.reset());

describe("announce", () => {
  it("drafts, waits for the named approver, sleeps until launch, then publishes", async () => {
    const launchAt = inSeconds(3);
    const runId = await client.start(
      announce,
      { title: "Acme Pro is here", body: "<p>Hello</p>", launchAt },
      { runId: randomUUID() },
    );

    await waitFor(pending(runId));
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect(Object.values(vendors.state.posts)[0]?.status).toBe("draft");

    await client.decide(runId, { decision: "approve", by: "intern" });
    await waitFor(async () => (await client.approvals(runId))[0]?.refused.length === 1);
    expect((await client.approvals(runId))[0]?.status).toBe("pending");
    expect(ops()).toHaveLength(2);

    await client.decide(runId, { decision: "approve", by: "marketing-lead", note: "ship it" });
    const result = (await client.result(runId)) as { post: string; social: string };

    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(launchAt));
    expect(ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "ghost.post.publish",
      "resend.broadcast.send",
      "bluesky.post.create",
    ]);
    expect(result.post).toBe("https://blog.example.test/acme-pro-is-here/");
    expect(vendors.state.social[0]?.text).toBe("Acme Pro is here https://blog.example.test/acme-pro-is-here/");
    const [approval] = await client.approvals(runId);
    expect(approval).toMatchObject({ status: "approved", decidedBy: "marketing-lead", note: "ship it" });
    expect((await client.steps(runId)).map((s) => s.name)).toEqual(expect.arrayContaining(["ghost.post.publish"]));
  });

  it("records the run in the ledger, in order, as the person who started it, with no policy", async () => {
    const runId = await client.start(
      announce,
      { title: "Ledger", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: "alice" },
    );
    await waitFor(pending(runId));
    await client.decide(runId, { decision: "approve", by: "marketing-lead" });
    await client.result(runId);

    const records = await client.ledger(runId);
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
    expect(new Set(records.map((r) => r.actor))).toEqual(new Set(["alice"]));
    expect(new Set(records.map((r) => r.runId))).toEqual(new Set([runId]));
    const decisions = records.flatMap((r) => (r.type === "op.called" ? [r.decision] : []));
    expect(decisions).toEqual(Array.from({ length: 5 }, () => ({ kind: "allow" })));
    expect(records[0]).toMatchObject({ type: "run.started", workflow: "announce", input: { title: "Ledger" } });
    expect(records[3]).toMatchObject({ approval: "approval-1", approver: "marketing-lead" });
    expect(records[4]).toMatchObject({ approval: "approval-1", decision: "approve", by: "marketing-lead" });
    expect(records.at(-1)).toMatchObject({ type: "run.finished", output: { post: expect.any(String) } });
    expect((await client.run(runId))?.startedBy).toBe("alice");
  });

  it("finishes after the worker is stopped and restarted mid-sleep, without repeating a step", async () => {
    const launchAt = inSeconds(4);
    const runId = await client.start(announce, { title: "Restart", body: "<p>x</p>", launchAt });
    await waitFor(pending(runId));
    await client.decide(runId, { decision: "approve", by: "marketing-lead" });
    await waitFor(async () => (await client.approvals(runId))[0]?.status === "approved");

    await worker.stop();
    expect(ops()).not.toContain("ghost.post.publish");
    worker = await start();

    await client.result(runId);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(launchAt));
    const counts = Object.groupBy(ops(), (op) => op);
    for (const op of Object.keys(counts)) expect(counts[op], op).toHaveLength(1);
    expect(Object.keys(counts)).toHaveLength(5);

    // The replay wrote run.started and the approval records again; the ledger kept one of each.
    const records = await client.ledger(runId);
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
    const runId = await client.start(announce, { title: "Garbled", body: "<p>x</p>", launchAt: inSeconds(1) });
    await waitFor(pending(runId));

    await raw.send(runId, { decision: "yes please", by: "marketing-lead" }, "approval-1");
    await raw.send(runId, "approve", "approval-1");
    await waitFor(async () => (await client.approvals(runId))[0]?.refused.length === 2);
    const [approval] = await client.approvals(runId);
    expect(approval).toMatchObject({ status: "pending", requestedBy: "workflow" });
    expect(approval?.refused).toEqual([
      { by: "marketing-lead", at: expect.any(Number), reason: "not a valid decision message" },
      { at: expect.any(Number), reason: "not a valid decision message" },
    ]);
    expect(ops()).toHaveLength(2);

    await client.decide(runId, { decision: "approve", by: "marketing-lead" });
    await client.result(runId);
    const records = await client.ledger(runId);
    expect(records.filter((r) => r.type === "approval.refused")).toEqual([
      expect.objectContaining({ id: `${runId}:approval.refused:approval-1:refused:1`, by: "marketing-lead" }),
      expect.objectContaining({ id: `${runId}:approval.refused:approval-1:refused:2`, reason: expect.any(String) }),
    ]);
    expect(records.at(-1)?.type).toBe("run.finished");
  });

  it("stops before publishing anything when the approver rejects", async () => {
    const runId = await client.start(
      announce,
      { title: "Nope", body: "<p>x</p>", launchAt: inSeconds(1) },
      { runId: randomUUID() },
    );
    await waitFor(pending(runId));
    await client.decide(runId, { decision: "reject", by: "marketing-lead", note: "wrong date" });

    await expect(client.result(runId)).rejects.toThrow(/rejected by marketing-lead: wrong date/);
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect((await client.run(runId))?.status).toBe("ERROR");
    const records = await client.ledger(runId);
    expect(records.at(-2)).toMatchObject({ type: "approval.decided", decision: "reject", note: "wrong date" });
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: expect.stringMatching(/rejected/) });
  });

  it("refuses input that doesn't match the workflow's schema before queueing", async () => {
    await expect(client.start(announce, { title: "", body: "x", launchAt: "tomorrow" })).rejects.toThrow(/launchAt/);
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
  const policy = definePolicy((call) => byActor[call.actor]?.(call) ?? allow());
  const policyLedger = memoryLedger();
  let policyClient: SanomaClient;
  const c = () => policyClient;

  beforeAll(async () => {
    await worker.stop();
    worker = await start({ policy, ledger: policyLedger });
    policyClient = await SanomaClient.connect(databaseUrl, { appName, ledger: policyLedger });
  });

  afterAll(() => policyClient?.close());

  it("fails the run when the policy denies a call, and records the denial", async () => {
    const runId = await c().start(
      announce,
      { title: "Denied", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: "no-email" },
    );
    await waitFor(pending(runId, 1, c));
    await c().decide(runId, { decision: "approve", by: "marketing-lead" });

    await expect(c().result(runId)).rejects.toThrow(/resend\.broadcast\.send was denied by policy: no email this week/);
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create", "ghost.post.publish"]);
    expect(Object.values(vendors.state.broadcasts).map((b) => b.status)).toEqual(["draft"]);

    const records = await c().ledger(runId);
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "resend.broadcast.send",
      effect: "send",
      decision: { kind: "deny", reason: "no email this week" },
      error: expect.stringMatching(/denied by policy/),
    });
    expect(records.at(-2)).not.toHaveProperty("output");
    expect(records.at(-1)).toMatchObject({ type: "run.failed", error: expect.stringMatching(/denied by policy/) });
  });

  it("holds a call for the approver the policy names, ignoring anyone else", async () => {
    const runId = await c().start(
      announce,
      { title: "Held", body: "<p>x</p>", launchAt: inSeconds(1), approver: "editor" },
      { startedBy: "lead-publishes" },
    );
    await waitFor(pending(runId, 1, c));
    await c().decide(runId, { decision: "approve", by: "editor" });

    await waitFor(pending(runId, 2, c));
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    const held = (await c().approvals(runId))[1];
    expect(held).toMatchObject({ title: "ghost.post.publish needs marketing-lead", approver: "marketing-lead" });

    await raw.send(runId, { decision: "approve", by: "intern" }, "approval-2");
    await waitFor(async () => (await c().approvals(runId))[1]?.refused.length === 1);
    expect((await c().approvals(runId))[1]?.status).toBe("pending");
    expect(ops()).toHaveLength(2);

    await c().decide(runId, { decision: "approve", by: "marketing-lead" });
    await c().result(runId);
    expect(ops()).toHaveLength(5);

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
      { startedBy: "lead-publishes" },
    );
    await waitFor(pending(runId, 1, c));
    await c().decide(runId, { decision: "approve", by: "editor" });
    await waitFor(pending(runId, 2, c));
    expect((await c().approvals(runId))[1]).toMatchObject({
      requestedBy: "policy",
      op: "ghost.post.publish",
      input: { id: expect.any(String) },
    });
    await c().decide(runId, { decision: "reject", by: "marketing-lead", note: "not today" });

    await expect(c().result(runId)).rejects.toThrow(/rejected by marketing-lead: not today/);
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    const records = await c().ledger(runId);
    expect(records.at(-2)).toMatchObject({
      type: "op.called",
      op: "ghost.post.publish",
      decision: { kind: "approve", approver: "marketing-lead" },
      approval: "approval-2",
      error: expect.stringMatching(/rejected by marketing-lead/),
    });
    expect(records.at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("fails the run, naming the operation, when the policy returns a malformed decision", async () => {
    const runId = await c().start(
      announce,
      { title: "Malformed", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: "approve-nobody" },
    );
    await waitFor(pending(runId, 1, c));
    await c().decide(runId, { decision: "approve", by: "marketing-lead" });

    await expect(c().result(runId)).rejects.toThrow(
      'The policy returned {"kind":"approve"} for ghost.post.publish: approve needs an approver',
    );
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect((await c().ledger(runId)).at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("gives calls held at the same time their own approvals", async () => {
    const runId = await c().start(twin, {}, { startedBy: "hold-each" });
    await waitFor(async () => (await c().approvals(runId)).filter((a) => a.status === "pending").length === 2);
    const held = await c().approvals(runId);
    expect(held.map((a) => a.id)).toEqual(["approval-1", "approval-2"]);
    expect(held.map((a) => (a.input as { text: string }).text).toSorted()).toEqual(["one", "two"]);
    expect(ops()).toEqual([]);

    await c().decide(runId, { decision: "approve", by: "lead" }, "approval-2");
    await c().decide(runId, { decision: "approve", by: "lead" }, "approval-1");
    await c().result(runId);
    expect(vendors.state.social.map((p) => p.text).toSorted()).toEqual(["one", "two"]);
  });

  it("does not wait again when the approver already approved earlier in the run", async () => {
    const runId = await c().start(
      announce,
      { title: "Once", body: "<p>x</p>", launchAt: inSeconds(1) },
      { startedBy: "lead-publishes" },
    );
    await waitFor(pending(runId, 1, c));
    await c().decide(runId, { decision: "approve", by: "marketing-lead" });
    await c().result(runId);

    expect(await c().approvals(runId)).toHaveLength(1);
    expect(ops()).toHaveLength(5);
    const decisions = (await c().ledger(runId)).flatMap((r) => (r.type === "op.called" ? [r.decision.kind] : []));
    expect(decisions).toEqual(["allow", "allow", "allow", "allow", "allow"]);
  });
});

describe("announce with a vendor that replies off-contract", () => {
  let publishes = 0;

  beforeAll(async () => {
    await worker.stop();
    const drivers = vendors.drivers.map((d) =>
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
    );
    worker = await start({ drivers });
  });

  it("does not retry an idempotent call whose reply fails the output schema", async () => {
    const runId = await client.start(announce, { title: "Off contract", body: "<p>x</p>", launchAt: inSeconds(1) });
    await waitFor(pending(runId));
    await client.decide(runId, { decision: "approve", by: "marketing-lead" });

    await expect(client.result(runId)).rejects.toThrow(/expected string/i);
    expect(publishes).toBe(1);
    const records = await client.ledger(runId);
    expect(records.at(-2)).toMatchObject({ type: "op.called", op: "ghost.post.publish", attempt: 1 });
    expect(records.at(-2)).not.toHaveProperty("output");
    expect(records.at(-1)).toMatchObject({ type: "run.failed" });
  });
});
