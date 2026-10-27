import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { GITHUB_API } from "../src/apps-list.ts";
import {
  defineConnector,
  defineWorkflow,
  type Driver,
  errorCode,
  type LedgerRecord,
  resolveConfig,
  withSetup,
} from "../src/index.ts";
import { defineFake } from "../src/fake.ts";
import { setupOf } from "../src/op.ts";
import { check, drive, loadScenarios, type Scenario } from "../src/scenario.ts";
import { runScenario } from "../src/scenarios.ts";
import announce from "./fixtures/announce.ts";
import { failure, inSeconds, pending, types, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
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

/** A vendor with a driver, and a fake that implements none of its operations. */
const lab = defineConnector("lab", {
  sample: { take: { effect: "write", input: z.object({}), output: z.object({}) } },
});
const labFake = defineFake(defineConnector("lab", {}), { initial: () => ({}), ops: () => ({}) });
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
  /** `driver`, each of whose functions records the call and throws. */
  const tripwire = ({ vendor, ops }: Driver): Driver => ({
    vendor,
    ops: Object.fromEntries(
      Object.keys(ops).map((key) => [
        key,
        async () => {
          live.push(`${vendor}.${key}`);
          throw new Error("a sandbox run called a driver");
        },
      ]),
    ),
  });
  const app = useApp("sandbox", (vendors) => ({
    workflows: [announce, review, sample],
    connectors: [
      // Each keeps its package's fake, which sandbox runs make their own of.
      ...vendors.connectors.map((c) => withSetup(c, { driver: () => tripwire(setupOf(c).driver!()) })),
      withSetup(lab, {
        driver: () => tripwire({ vendor: "lab", ops: { "sample.take": async () => ({}) } }),
        fake: () => labFake,
      }),
    ],
    // Its scenarios are fixtures/scenarios/.
    root: fileURLToPath(new URL("./fixtures/", import.meta.url)),
  }));
  const c = () => app.client;

  const scope = () => resolveConfig(app.config);
  const scenario = async (name: string): Promise<Scenario> => {
    const loaded = await loadScenarios(scope());
    expect(loaded.errors).toEqual([]);
    return loaded.scenarios.find((s) => s.name === name)!;
  };
  const checked = async (s: Scenario, records: LedgerRecord[]) => check(scope(), s, records);
  const steps = async (runId: string) => ((await app.raw.listWorkflowSteps(runId)) ?? []).map((s) => s.name);
  const ledger = (runId: string) => c().ledger(runId);

  it("seeds the fakes, calls them and no driver, and skips the sleep but records it", async () => {
    const launch = await scenario("Launch on time");
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
    // The drivers' fakes are untouched: the run seeded and called fakes of its own.
    expect(app.ops()).toEqual([]);

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
    // The run's own Ghost: the seeded draft is post_0001, so the run's post is post_0002.
    expect(await checked(launch, records)).toEqual(launch.expect.map((e) => ({ step: e.step, ok: true })));

    expect((await c().run(runId))?.sandbox).toBe("Launch on time");
    const listed = (await c().runs()).find((r) => r.runId === runId);
    expect(listed?.sandbox).toBe("Launch on time");
  });

  it("retries an idempotent operation the scenario fails once, and finishes", async () => {
    const retried = await scenario("Publish retried");
    const runId = await c().start(announce, retried.input as never, { startedBy: alice, sandbox: retried.name });
    expect(await drive(c(), runId, retried)).toMatchObject({ status: "finished" });
    const records = await ledger(runId);
    // One record per call, with the try that produced its output.
    expect(records.filter((r) => r.type === "op.called" && r.op === "ghost.post.publish")).toMatchObject([
      { attempt: 2, output: { id: "post_0001", status: "published" } },
    ]);
    expect((await checked(retried, records)).every((r) => r.ok)).toBe(true);
  });

  it("decides each approval by its title first, then in order", async () => {
    for (const name of ["Decided by title", "Decided in order"]) {
      const runId = await c().start(review, {}, { startedBy: alice, sandbox: name });
      expect(await drive(c(), runId, await scenario(name))).toMatchObject({ status: "finished" });
      expect((await c().approvals(runId)).map((a) => [a.title, a.status, a.decidedBy])).toEqual([
        ["Legal review", "approved", "legal"],
        ["Final check", "approved", "boss"],
      ]);
    }
  });

  it("runs two sandbox runs of one scenario at once, each on its own fakes, and refuses a scenario that does not exist", async () => {
    const launch = await scenario("Launch on time");
    const start = () => c().start(announce, launch.input as never, { startedBy: alice, sandbox: launch.name });
    const runIds = await Promise.all([start(), start()]);
    // Each waits on its own approval: neither is queued behind the other.
    for (const runId of runIds) await waitFor(pending(c, runId));

    const runs = await Promise.all(runIds.map((runId) => drive(c(), runId, launch)));
    expect(runs.map((r) => r.status)).toEqual(["finished", "finished"]);
    for (const runId of runIds) {
      const records = await ledger(runId);
      // Each seeded its own Ghost: the scenario's `post_0002` is published in both, which a shared
      // one could not do.
      expect(await checked(launch, records)).toEqual(launch.expect.map((e) => ({ step: e.step, ok: true })));
    }
    expect(app.ops()).toEqual([]);

    const unknown = await c().start(announce, launch.input as never, { startedBy: alice, sandbox: "Nope" });
    const missing = await failure(c().result(unknown));
    expect(errorCode(missing)).toBe("invalid_input");
    expect((missing as Error).message).toBe('No scenario named "Nope"');
    expect(types(await ledger(unknown))).toEqual(["run.started", "run.failed"]);
  });

  it("runs a direct call: the built-in drivers no fake implements are there beside the fakes", async () => {
    // `call` uses every operation that may be called directly, `sanoma.apps.list` among them, which
    // no connector's fake implements: the sandbox calls its built-in driver instead of refusing the run.
    // That driver searches GitHub, mocked here.
    const github = setupServer(
      http.get(`${GITHUB_API}/search/repositories`, () =>
        HttpResponse.json({ items: [{ full_name: "acme/crm", html_url: "https://github.com/acme/crm" }] }),
      ),
    );
    github.listen();
    onTestFinished(() => github.close());
    const direct = await scenario("Apps listed directly");
    const { run, checks, ledger: records } = await runScenario(direct, { client: c(), scope: scope() });
    expect(run).toMatchObject({ status: "finished" });
    expect(records.find((r) => r.type === "op.called" && r.op === "sanoma.apps.list")).toMatchObject({
      output: { apps: [{ repo: "acme/crm" }] },
    });
    expect(checks.filter((k) => !k.ok)).toEqual([]);
    expect(live).toEqual([]);
  });

  it("refuses a workflow that uses an operation with no fake, and parses the input before seeding", async () => {
    const runId = await c().start(sample, {}, { startedBy: alice, sandbox: "Sampled" });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as Error).message).toBe(
      "A sandbox run of sample has no fake for lab.sample.take: no fake its connectors attach implements it",
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
    const launch = await scenario("Launch on time");
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

  it("refuses a sandbox that is not a scenario's name", async () => {
    for (const sandbox of [7, ""]) {
      const err = await failure(c().start(review, {}, { startedBy: alice, sandbox: sandbox as never }));
      expect(errorCode(err)).toBe("invalid_input");
      expect((err as Error).message).toMatch(/^`sandbox` must be the name of a scenario in the config's `scenarios\/`/);
    }
  });

  it("refuses to reuse a run id for a start in another sandbox, or none", async () => {
    const launch = await scenario("Launch on time");
    const runId = randomUUID();
    await c().start(announce, launch.input as never, { runId, startedBy: alice, sandbox: launch.name });
    const err = await failure(c().start(announce, launch.input as never, { runId, startedBy: alice }));
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as { data: unknown }).data).toEqual({ runId, differs: ["sandbox"] });
    expect(await drive(c(), runId, launch)).toMatchObject({ status: "finished" });
  });

  it("never takes a decision naming an approval still to come for the one pending", async () => {
    const second = await scenario("Decided for the second only");
    expect(second.approvals).toEqual(["Legal review", "Final check"]);
    const runId = await c().start(review, {}, { startedBy: alice, sandbox: second.name });
    await expect(drive(c(), runId, second)).rejects.toThrow(
      'Scenario "Decided for the second only" has no decision for "Legal review" (approval-1); the decisions left are for "Final check"',
    );
    await c().decide(runId, { decision: "approve", by: { id: "legal" } });
    await waitFor(pending(c, runId, 2));
    await c().decide(runId, { decision: "approve", by: { id: "boss" } });
    expect(await c().result(runId)).toBe("reviewed");
  });

  it("throws for an approval the scenario has no decision left for", async () => {
    const short = await scenario("Missing a decision");
    const runId = await c().start(review, {}, { startedBy: alice, sandbox: short.name });
    await expect(drive(c(), runId, short)).rejects.toThrow(
      'Scenario "Missing a decision" has no decision for "Final check" (approval-2)',
    );
    await c().decide(runId, { decision: "approve", by: { id: "boss" } });
    expect(await c().result(runId)).toBe("reviewed");
  });
});
