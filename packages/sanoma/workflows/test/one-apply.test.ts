import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { startTestWorker } from "sanoma/testing";
import { fakeHost, testRepository } from "sanoma/testing/host";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readLockfile, writeLockfile } from "../src/describe.ts";
import {
  type ChangeReport,
  dbosClient,
  defineWorkflow,
  type Driver,
  memoryLedger,
  type Principal,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Source,
  type Worker,
  withSetup,
} from "../src/index.ts";
import { fakeMail, mailDataFile } from "./fakes/mail.ts";
import { fakeRemote, memorySource } from "./fakes/remote.ts";
import { freshDatabase, pending, rootWith, setBuiltInCode, testhostInfra, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. One live apply at a time on a database: a second waits on the
// apply queue, named by `applyAhead`, whoever starts it (a person, or a change's deploy); a sandbox
// apply does not wait; a worker on a new version carries the old one's applies of its own code and
// those queued, in their places, and cancels one started on other code, so the queue's one place is free again.

const here = dirname(fileURLToPath(import.meta.url));
const alice: Principal = { id: "alice" };
const careful: Principal = { id: "careful" };
// Every change of careful's waits for the lead: an apply of theirs waits at its plan's approval.
const POLICY = `@hold("lead")
forbid (principal == Sanoma::Principal::"careful", action in Sanoma::Action::"effect:write", resource);
`;
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const careful = sanoma.person({ id: "careful" });
export const lead = sanoma.person({ id: "lead" });
`;
const sending = "resources/mail.ts#sending";

/**
 * `fakeMail` behind a gate: while `hold` holds it, every operation waits, and `most` counts the
 * most operations ever in flight at once, so two applies that ran together show as two.
 */
function gatedMail() {
  const mail = fakeMail();
  let gate = Promise.resolve();
  let release: (() => void) | undefined;
  let inFlight = 0;
  let most = 0;
  const ops = Object.fromEntries(
    Object.entries(mail.driver.ops).map(([name, op]) => [
      name,
      (async (input, ctx) => {
        most = Math.max(most, ++inFlight);
        try {
          await gate;
          return await op(input, ctx);
        } finally {
          inFlight--;
        }
      }) satisfies typeof op,
    ]),
  );
  const driver: Driver = { ...mail.driver, ops };
  return {
    mail,
    connector: withSetup(mail.connector, { driver: () => driver }),
    hold: () => void (gate = new Promise((done) => (release = done))),
    open: () => release?.(),
    inFlight: () => inFlight,
    most: () => most,
    reset: () => {
      mail.reset();
      most = 0;
    },
  };
}

/** A source that takes commits and records none: the lockfile is all apply writes. */
const committing = (root: string): Source => {
  let n = 0;
  return { root, commit: () => ({ revision: `rev${++n}` }), head: () => `rev${n}` };
};

describe("one apply at a time", () => {
  const databaseUrl = freshDatabase("one-apply");
  const root = rootWith({
    "policies/policy.cedar": POLICY,
    "resources/people.ts": PEOPLE,
    "resources/mail.ts": mailDataFile,
    "scenarios/apply.feature": ["Feature: Apply", "  Scenario: Applied in the sandbox", "    When apply runs", ""].join(
      "\n",
    ),
  });
  const gated = gatedMail();
  const config: SanomaConfig = { workflows: [], connectors: [gated.connector], ledger: memoryLedger(), root };
  const resolved = resolveConfig({ ...config, databaseUrl });
  let worker: Worker;
  let client: SanomaClient;
  let raw: DBOSClient;
  beforeAll(async () => {
    worker = await startTestWorker(config, { databaseUrl, source: committing(root) });
    client = await SanomaClient.connect({ ...config, databaseUrl });
    raw = await dbosClient(databaseUrl);
  });
  afterAll(async () => {
    gated.open();
    await raw?.destroy();
    await client?.close();
    await worker?.stop();
  });
  beforeEach(() => {
    gated.reset();
    writeLockfile(root, {});
  });
  afterEach(() => gated.open());

  const row = (runId: string) => raw.getWorkflow(runId);
  /** True once the run has been ENQUEUED a few of the queue's polls (50 ms in the suite): it is not just about to start. */
  const stillQueued = async (runId: string) => {
    await new Promise((r) => setTimeout(r, 500));
    return (await row(runId))?.status === "ENQUEUED";
  };

  it("registers the apply queue with one run at a time across the database's workers", async () => {
    const queue = (await raw.listQueues(resolved.appName)).find((q) => q.name === resolved.applyQueueName);
    expect(resolved.applyQueueName).toBe(`sanoma:${resolved.appName}:apply`);
    expect(queue?.concurrency).toBe(1);
  });

  it("runs a second apply only once the first ends, naming the first as the one ahead", async () => {
    gated.hold();
    const first = await client.apply({}, { startedBy: alice });
    await waitFor(() => gated.inFlight() === 1);
    const second = await client.apply({}, { startedBy: alice });
    expect(await stillQueued(second)).toBe(true);
    expect(await row(second)).toMatchObject({ queueName: resolved.applyQueueName });
    expect(gated.most()).toBe(1);
    expect(await client.applyAhead(second)).toMatchObject({ runId: first });
    expect(await client.applyAhead(first)).toBeUndefined();
    gated.open();
    expect((await client.applyReport(first)).results).toEqual([
      expect.objectContaining({ id: sending, status: "done", action: "create" }),
      expect.objectContaining({ status: "done" }),
    ]);
    // The second plans after the first wrote: nothing is left to do.
    expect((await client.applyReport(second)).plan.steps.map((s) => s.action)).toEqual(["none", "none"]);
    expect(gated.most()).toBe(1);
  });

  it("lets the worker stop while an apply waits for a person and another waits behind it", async () => {
    const held = await client.apply({ only: [sending] }, { startedBy: careful });
    await waitFor(pending(() => client, held));
    const behind = await client.apply({}, { startedBy: alice });
    expect(await stillQueued(behind)).toBe(true);
    expect(await client.applyAhead(behind)).toMatchObject({ runId: held, status: "waiting" });
    // Nothing can run until the lead decides: the queued apply cannot start before the held one ends.
    expect(await worker.idle()).toBe(true);
    await client.decide(held, { decision: "approve", by: { id: "lead" } });
    expect((await client.applyReport(held)).results).toEqual([
      expect.objectContaining({ id: sending, status: "done" }),
    ]);
    await client.applyReport(behind);
  });

  it("runs a sandbox apply while a live one holds the queue: it calls fakes, not the hosts", async () => {
    const held = await client.apply({ only: [sending] }, { startedBy: careful });
    await waitFor(pending(() => client, held));
    const sandboxed = await client.apply({}, { startedBy: alice, sandbox: "Applied in the sandbox" });
    expect(await row(sandboxed)).toMatchObject({ queueName: resolved.queueName });
    expect(await client.result(sandboxed, 15_000)).toMatchObject({ results: expect.any(Array) });
    await client.decide(held, { decision: "approve", by: { id: "lead" } });
    await client.applyReport(held);
  });
});

/** A company workflow the merge adds: v2 has it, v1 does not. */
const added = defineWorkflow({
  name: "added",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => "added",
});

describe("one apply at a time across a deploy", () => {
  const databaseUrl = freshDatabase("one-apply-versions");
  const source = testRepository();
  const root = rootWith({
    "policies/policy.cedar": POLICY,
    "resources/people.ts": PEOPLE,
    "resources/mail.ts": mailDataFile,
    "resources/infra.ts": testhostInfra(source.url),
  });
  const host = fakeHost(async () => ({ url: "http://127.0.0.1:4100", stop: async () => {} }));
  const gated = gatedMail();
  const remote = fakeRemote();
  const repo = memorySource({ root: here, remote });
  const base = {
    connectors: [host.connector, remote.connector, gated.connector],
    ledger: memoryLedger(),
    root,
    databaseUrl,
  } satisfies SanomaConfig;
  const v1: SanomaConfig = { ...base, workflows: [] };
  const v2: SanomaConfig = { ...base, workflows: [added] };
  const [one, two] = [resolveConfig(v1), resolveConfig(v2)];
  const workers: Worker[] = [];
  let client: SanomaClient;
  let raw: DBOSClient;
  const hostId = "resources/infra.ts#app";

  beforeAll(async () => {
    await source.commit();
    client = await SanomaClient.connect(v2);
    raw = await dbosClient(databaseUrl);
  });
  afterEach(async () => {
    gated.open();
    vi.restoreAllMocks();
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });
  afterAll(async () => {
    await raw?.destroy();
    await client?.close();
    await host.close();
    source.remove();
    repo.remove();
  });

  const start = async (config: SanomaConfig) => {
    const worker = await startTestWorker(config, { databaseUrl, source: repo.source, promote: true });
    workers.push(worker);
    return worker;
  };
  const row = (runId: string) => raw.getWorkflow(runId);
  const stop = async (worker: Worker) => {
    workers.splice(workers.indexOf(worker), 1);
    await worker.stop();
  };
  /** A change of `id` opened and published by alice, who may decide her own. */
  const publish = async (id: string) => {
    repo.edit(id, { [`notes/${id}.md`]: "\n" });
    const runId = await client.openChange({ id, title: `Change ${id}` }, { startedBy: "alice" });
    await waitFor(pending(() => client, runId));
    await client.decide(runId, { decision: "approve", by: { id: "alice" } });
    return runId;
  };

  it("queues a change's deploy behind an apply already running, and deploys once it ends", async () => {
    await start(v1);
    // Gone live: its apply binds the host, so a merge deploys it.
    await client.applyReport(await client.apply({ only: [hostId] }, { startedBy: alice }));
    gated.hold();
    const first = await client.apply({ only: [sending] }, { startedBy: alice });
    await waitFor(() => gated.inFlight() === 1);
    const runId = await publish("queued");
    const deploy = `${runId}:deploy`;
    await waitFor(async () => (await row(deploy))?.status === "ENQUEUED");
    expect(await row(deploy)).toMatchObject({ queueName: resolveConfig(v1).applyQueueName });
    expect(await client.applyAhead(deploy)).toMatchObject({ runId: first });
    gated.open();
    const report = (await client.result(runId, 60_000)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", deploy: { apply: { runId: deploy, hosts: [hostId] } } });
    expect(report.deploy!.apply).not.toHaveProperty("error");
  });

  it("carries the old version's applies at a new version's start: the held one goes on, the deploy queued behind it runs next", async () => {
    // The mail domain made again, so careful's apply has a change to wait at.
    writeLockfile(root, { [hostId]: readLockfile(root).bindings[hostId]! });
    gated.reset();
    const old = await start(v1);
    const held = await client.apply({ only: [sending] }, { startedBy: careful });
    await waitFor(pending(() => client, held));
    const runId = await publish("carried");
    const deploy = `${runId}:deploy`;
    await waitFor(async () => (await row(deploy))?.status === "ENQUEUED");
    // Started by the change's own run, it carries its code as the client's starts do.
    expect((await row(deploy))?.attributes).toMatchObject({ builtInCode: one.builtInCodes.apply });
    await stop(old);

    await start(v2);
    expect(await row(held)).toMatchObject({ applicationVersion: two.version });
    expect(await row(deploy)).toMatchObject({ status: "ENQUEUED", applicationVersion: two.version });
    await waitFor(async () => (await row(held))?.status === "PENDING");
    expect(await client.applyAhead(deploy)).toMatchObject({ runId: held, status: "waiting" });
    await client.decide(held, { decision: "approve", by: { id: "lead" } });
    expect((await client.applyReport(held)).results).toEqual([
      expect.objectContaining({ id: sending, status: "done" }),
    ]);
    const report = (await client.result(runId, 60_000)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", deploy: { apply: { runId: deploy, hosts: [hostId] } } });
    expect(report.deploy!.apply).not.toHaveProperty("error");
  });

  it("cancels an apply started on other code at a new version's start, which frees the queue, and its change says its deploy was cancelled", async () => {
    // A new commit for the host, so careful's deploy has a change to wait at.
    await source.commit();
    const old = await start(v1);
    repo.edit("careful", { "notes/careful.md": "\n" });
    const runId = await client.openChange({ id: "careful", title: "Change careful" }, { startedBy: "careful" });
    const deploy = `${runId}:deploy`;
    // Each of careful's writes waits for the lead: the change's are approved until its deploy waits at its own.
    await waitFor(async () => {
      const asked = (await client.approvals(runId)).find((a) => a.status === "pending");
      // Every hold here is the lead's, a person.
      if (asked) await client.decide(runId, { decision: "approve", by: { id: asked.approver as string } });
      return pending(() => client, deploy)();
    }, 30_000);
    const behind = await client.apply({ only: [sending] }, { startedBy: alice });
    expect(await client.applyAhead(behind)).toMatchObject({ runId: deploy });
    await stop(old);
    // Started by other apply code: the runtime's own, before an upgrade.
    await setBuiltInCode(databaseUrl, deploy, "other");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(v2);
    const cancelled = warn.mock.calls.map(([m]) => String(m)).find((m) => m.includes("cancelled 1 apply run(s)"));
    expect(cancelled).toBe(
      `sanoma: cancelled 1 apply run(s) started on other code, which no worker would run: ${deploy}. Apply again.`,
    );
    expect(await row(deploy)).toMatchObject({ status: "CANCELLED" });
    // The change, carried onto the new version, ends saying so.
    const report = (await client.result(runId, 60_000)) as ChangeReport;
    expect(report).toMatchObject({ outcome: "merged", deploy: { apply: { runId: deploy } } });
    expect(report.deploy!.apply!.error).toMatch(/cancelled/);
    // The queue's one place is free: the apply queued behind, carried, runs.
    expect(await row(behind)).toMatchObject({ applicationVersion: two.version });
    expect((await client.applyReport(behind)).plan.steps.map((s) => s.action)).toEqual(["none"]);
  });
});
