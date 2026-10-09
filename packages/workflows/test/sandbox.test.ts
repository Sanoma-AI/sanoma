import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow, type Driver, errorCode, type LedgerRecord, resolveConfig } from "../src/index.ts";
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

describe("sandbox runs", () => {
  /** Operations the drivers were called with: a sandbox run calls none. */
  const live: string[] = [];
  const app = useApp(databaseUrl, "sandbox", (vendors) => ({
    workflows: [announce, review],
    drivers: vendors.drivers.map((d): Driver => ({
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

  it("refuses a second sandbox run while one waits, and a scenario that does not exist", async () => {
    const launch = scenario("Launch on time");
    const first = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    await waitFor(pending(c, first));

    const second = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    const busy = await failure(c().result(second));
    expect(errorCode(busy)).toBe("sandbox_busy");
    expect((busy as Error).message).toContain(first);

    expect(await drive(c(), first, launch)).toMatchObject({ status: "finished" });

    const unknown = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: "Nope" });
    const missing = await failure(c().result(unknown));
    expect(errorCode(missing)).toBe("invalid_input");
    expect((missing as Error).message).toBe('No scenario named "Nope"');
    expect(types(await ledger(unknown))).toEqual(["run.started", "run.failed"]);
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
