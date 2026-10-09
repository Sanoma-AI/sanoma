import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { bluesky } from "@sanoma/connector-bluesky";
import {
  defineConnector,
  defineWorkflow,
  type Driver,
  errorCode,
  type LedgerRecord,
  resolveConfig,
} from "../src/index.ts";
import { check, drive, loadScenarios, type Scenario } from "../src/scenario.ts";
import announce from "./fixtures/announce.ts";
import { failure, inSeconds, pending, types, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("sandbox");
const alice = { id: "alice", groups: ["marketing"] };

/** Two approvals, one after the other. */
const review = defineWorkflow({
  name: "review-twice",
  trigger: "manual",
  input: z.object({}),
  uses: ["approval"],
  run: async (ctx) => {
    await ctx.approval("Legal review", { approver: "legal" });
    await ctx.approval("Final check", { approver: "boss" });
    return "reviewed";
  },
});

/** A vendor with a driver and no fake. */
const lab = defineConnector("lab", {
  sample: { take: { effect: "write", input: z.object({}), output: z.object({}) } },
});
const sample = defineWorkflow({
  name: "sample",
  trigger: "manual",
  input: z.object({}),
  uses: [lab.sample.take],
  run: async (ctx) => ctx.lab.sample.take({}),
});

describe("sandbox runs", () => {
  /** Operations the drivers were called with: a sandbox run calls none. */
  const live: string[] = [];
  const app = useApp(databaseUrl, "sandbox", (vendors) => ({
    workflows: [announce, review, sample],
    connectors: [ghost, resend, bluesky, lab],
    drivers: [...vendors.drivers, { vendor: "lab", ops: { "sample.take": async () => ({}) } }].map((d): Driver => ({
      vendor: d.vendor,
      ops: Object.fromEntries(
        Object.keys(d.ops).map((key) => [
          key,
          async () => {
            live.push(`${d.vendor}.${key}`);
            throw new Error("a sandbox run called a driver");
          },
        ]),
      ),
    })),
    scenarios: new URL("./fixtures/scenarios/", import.meta.url),
  }));
  const c = () => app.client;

  const scenario = (name: string): Scenario => {
    const loaded = loadScenarios(resolveConfig(app.config));
    expect(loaded.errors).toEqual([]);
    return loaded.scenarios.find((s) => s.name === name)!;
  };
  const steps = async (runId: string) => ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);
  const ledger = (runId: string) => c().ledger(runId);

  it("seeds the fakes, calls them and no driver, and skips the sleep but records it", async () => {
    const launch = scenario("Launch on time");
    const launchAt = inSeconds(86_400);
    const started = Date.now();
    const runId = await c().start(announce, { ...(launch.input as object), launchAt } as never, {
      startedBy: alice,
      sandbox: launch.name,
    });
    const run = await drive(c(), runId, launch);

    expect(run).toMatchObject({ status: "finished", sandbox: "Launch on time" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(live).toEqual([]);
    // The seed went through the fake, but is not in the call log: the log holds the run's calls only.
    expect(app.ops()).toEqual([
      "ghost.post.create",
      "resend.broadcast.create",
      "ghost.post.publish",
      "resend.broadcast.send",
      "bluesky.post.create",
    ]);
    expect(Object.values(app.vendors.ghost.state.posts).map((p) => [p.id, p.title, p.status])).toEqual([
      ["post_0001", "Old news", "draft"],
      ["post_0002", "Acme Pro", "published"],
    ]);

    const records = await ledger(runId);
    expect(types(records)).toEqual([
      "run.started",
      "scenario.seeded",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "approval.requested",
      "approval.decided",
      "sleep.started",
      "op.called ghost.post.publish",
      "op.called resend.broadcast.send",
      "op.called bluesky.post.create",
      "run.finished",
    ]);
    expect(records[1]).toMatchObject({
      type: "scenario.seeded",
      scenario: "Launch on time",
      seeds: [
        {
          op: "ghost.post.create",
          input: { title: "Old news", status: "draft" },
          output: { id: "post_0001", slug: "old-news", status: "draft" },
        },
      ],
    });
    const sleep = records.find((r) => r.type === "sleep.started") as Extract<LedgerRecord, { type: "sleep.started" }>;
    expect(sleep.until).toBe(Date.parse(launchAt));
    // The one DBOS.sleep is the approval's: DBOS.recv waits with it. The ctx.sleep reads the
    // clock (the last DBOS.now) and goes straight on to publishing.
    expect(await steps(runId)).toEqual([
      "sandbox:seed",
      "policy:ghost.post.create",
      "ghost.post.create",
      "policy:resend.broadcast.create",
      "resend.broadcast.create",
      "DBOS.now",
      "DBOS.setEvent",
      "DBOS.recv",
      "DBOS.sleep",
      "DBOS.now",
      "DBOS.setEvent",
      "DBOS.setEvent",
      "DBOS.now",
      "policy:ghost.post.publish",
      "ghost.post.publish",
      "policy:resend.broadcast.send",
      "resend.broadcast.send",
      "policy:bluesky.post.create",
      "bluesky.post.create",
    ]);
    expect(check(launch, records)).toEqual(launch.expect.map((e) => ({ step: e.step, ok: true })));

    expect((await c().run(runId))?.sandbox).toBe("Launch on time");
    const listed = (await c().runs()).find((r) => r.runId === runId);
    expect(listed?.sandbox).toBe("Launch on time");
  });

  it("retries an idempotent operation the scenario fails once, and finishes", async () => {
    const retried = scenario("Publish retried");
    const runId = await c().start(announce, retried.input as never, { startedBy: alice, sandbox: retried.name });
    expect(await drive(c(), runId, retried)).toMatchObject({ status: "finished" });
    const publishes = app.vendors.calls.filter((call) => call.op === "ghost.post.publish");
    expect(publishes.map((call) => call.attempt)).toEqual([1, 2]);
    expect(check(retried, await ledger(runId)).every((r) => r.ok)).toBe(true);
  });

  it("decides each approval by its title first, then in order", async () => {
    for (const name of ["Decided by title", "Decided in order"]) {
      const runId = await c().start(review, {}, { startedBy: alice, sandbox: name });
      expect(await drive(c(), runId, scenario(name))).toMatchObject({ status: "finished" });
      expect((await c().approvals(runId)).map((a) => [a.title, a.status, a.decidedBy])).toEqual([
        ["Legal review", "approved", "legal"],
        ["Final check", "approved", "boss"],
      ]);
    }
  });

  it("starts a second sandbox run once the one waiting on an approval ends, and refuses a scenario that does not exist", async () => {
    const launch = scenario("Launch on time");
    const first = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    await waitFor(pending(c, first));

    const second = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    // Longer than the queue's dispatch interval (a second): it would have started by now.
    await delay(2_000);
    expect((await c().run(second))?.status).toBe("queued");
    expect(await ledger(second)).toEqual([]);

    expect(await drive(c(), first, launch)).toMatchObject({ status: "finished" });
    expect(await drive(c(), second, launch)).toMatchObject({ status: "finished" });
    const [one, two] = await Promise.all([ledger(first), ledger(second)]);
    expect(two[0]!.at).toBeGreaterThanOrEqual(one.at(-1)!.at);

    const unknown = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: "Nope" });
    const missing = await failure(c().result(unknown));
    expect(errorCode(missing)).toBe("invalid_input");
    expect((missing as Error).message).toBe('No scenario named "Nope"');
    expect(types(await ledger(unknown))).toEqual(["run.started", "run.failed"]);
  });

  it("refuses a workflow that uses an operation with no fake, and parses the input before seeding", async () => {
    const runId = await c().start(sample, {}, { startedBy: alice, sandbox: "Sampled" });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as Error).message).toBe(
      "A sandbox run of sample has no fake for lab.sample.take: add their vendors' fakes to the config's `fakes`",
    );
    expect(live).toEqual([]);

    // Enqueued as the client would, without its check of the input.
    const { queueName, appName } = resolveConfig(app.config);
    const handle = await app.raw.enqueue(
      { queueName, workflowName: "announce", applicationName: appName },
      { input: {}, startedBy: alice, sandbox: "Launch on time" },
    );
    const bad = await failure(c().result(handle.workflowID));
    expect((bad as Error).message).toMatch(/^The input does not match announce's schema/);
    expect(types(await ledger(handle.workflowID))).toEqual(["run.started", "run.failed"]);
  });

  it("fails a sandbox run whose worker restarts, since the fakes' state is gone", async () => {
    const launch = scenario("Launch on time");
    const runId = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    await waitFor(pending(c, runId));

    await app.restart();

    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as Error).message).toBe(
      `Sandbox run ${runId} was interrupted by a worker restart and the fakes' state is gone; start the scenario again`,
    );
    expect(types(await ledger(runId))).toEqual([
      "run.started",
      "scenario.seeded",
      "op.called ghost.post.create",
      "op.called resend.broadcast.create",
      "approval.requested",
      "run.failed",
    ]);
    const records = await ledger(runId);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
  });

  it("refuses to reuse a run id for a start in another sandbox, or none", async () => {
    const launch = scenario("Launch on time");
    const runId = randomUUID();
    await c().start(announce, launch.input as never, { runId, startedBy: alice, sandbox: launch.name });
    const err = await failure(c().start(announce, launch.input as never, { runId, startedBy: alice }));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as { data: unknown }).data).toEqual({ runId, differs: ["sandbox"] });
    expect(await drive(c(), runId, launch)).toMatchObject({ status: "finished" });
  });

  it("never takes a decision naming an approval still to come for the one pending", async () => {
    const second = scenario("Decided for the second only");
    expect(second.approvals).toEqual(["Legal review", "Final check"]);
    const runId = await c().start(review, {}, { startedBy: alice, sandbox: second.name });
    await expect(drive(c(), runId, second)).rejects.toThrow(
      'Scenario "Decided for the second only" has no decision for "Legal review" (approval-1); the decisions left are for "Final check"',
    );
    // Finished by hand, so the next sandbox run can start.
    await c().decide(runId, { decision: "approve", by: { id: "legal" } });
    await waitFor(pending(c, runId, 2));
    await c().decide(runId, { decision: "approve", by: { id: "boss" } });
    expect(await c().result(runId)).toBe("reviewed");
  });

  it("throws for an approval the scenario has no decision left for", async () => {
    const short = scenario("Missing a decision");
    const runId = await c().start(review, {}, { startedBy: alice, sandbox: short.name });
    await expect(drive(c(), runId, short)).rejects.toThrow(
      'Scenario "Missing a decision" has no decision for "Final check" (approval-2)',
    );
    // Finished by hand, so the fakes are free for the next sandbox run.
    await c().decide(runId, { decision: "approve", by: { id: "boss" } });
    expect(await c().result(runId)).toBe("reviewed");
  });
});
