import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { startTestWorker } from "sanoma/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { queueFor } from "../src/config.ts";
import {
  dbosClient,
  defineWorkflow,
  memoryLedger,
  type Principal,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Worker,
} from "../src/index.ts";
import { freshDatabase, pending, rootWith, stillQueued, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. A workflow with `concurrency: "one per person"` runs each person's
// runs one after another, on DBOS's partitioned queue: a second run for alice waits, queued, for
// her first to end, whoever started it (her, or an agent for her), and names it as the one ahead;
// bob's never waits for hers; a run that ends in any way (finished, failed, cancelled) lets the
// next start; the order holds across a worker's restart; a start held for an approval keeps its
// place; a new version's worker cancels a run of the old code that holds a place no one would
// free; and an anonymous start is refused.

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const bob = sanoma.person({ id: "bob" });
export const wary = sanoma.person({ id: "wary" });
export const lead = sanoma.person({ id: "lead" });
export const bot = sanoma.agent({ id: "bot" });
export const admin = sanoma.group({ name: "admin", members: [lead] });
`;
// Every start of wary's waits for the lead.
const POLICY = `@hold("lead")
forbid (principal == Sanoma::Principal::"wary", action == Sanoma::Action::"workflow:open-box", resource);
`;

const openBox = defineWorkflow({
  name: "open-box",
  trigger: "manual",
  input: z.object({ n: z.number() }),
  uses: ["approval"],
  concurrency: "one per person",
  run: async (ctx, { n }) => {
    await ctx.approval("Open it?", { approver: "lead" });
    return n;
  },
});

const alice: Principal = { id: "alice" };
const bob: Principal = { id: "bob" };
const wary: Principal = { id: "wary" };
const lead = { id: "lead" };
const botForAlice: Principal = { id: "bot", onBehalfOf: "alice" };

describe("one run at a time per person", () => {
  const databaseUrl = freshDatabase("one-per-person");
  const root = rootWith({ "resources/people.ts": PEOPLE, "policies/policy.cedar": POLICY });
  const config: SanomaConfig = { workflows: [openBox], connectors: [], ledger: memoryLedger(), root, databaseUrl };
  const resolved = resolveConfig(config);
  let worker: Worker;
  let client: SanomaClient;
  let raw: DBOSClient;
  beforeAll(async () => {
    worker = await startTestWorker(config, { databaseUrl });
    client = await SanomaClient.connect(config);
    raw = await dbosClient(databaseUrl);
  });
  afterEach(async () => {
    const left = await raw.listWorkflows({ status: ["PENDING", "ENQUEUED"], loadInput: false });
    if (left.length) await raw.cancelWorkflows(left.map((r) => r.workflowID));
  });
  afterAll(async () => {
    await raw?.destroy();
    await client?.close();
    await worker?.stop();
  });

  const row = (runId: string) => raw.getWorkflow(runId);
  const approve = (runId: string) => client.decide(runId, { decision: "approve", by: lead });
  const recordAt = async (runId: string, type: string) => (await client.ledger(runId)).find((r) => r.type === type)!.at;

  it("registers the queue with one run at a time in each partition", async () => {
    const queue = (await raw.listQueues(resolved.appName)).find((q) => q.name === resolved.perPersonQueueName);
    expect(resolved.perPersonQueueName).toBe(`sanoma:${resolved.appName}:per-person`);
    expect(queue?.partitionConcurrency).toBe(1);
  });

  it("starts a person's second run only once the first ends, naming the first as the one ahead", async () => {
    const first = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, first));
    const second = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, second)).toBe(true);
    expect(await row(second)).toMatchObject({ queueName: resolved.perPersonQueueName });
    expect(await client.run(second)).toMatchObject({ status: "queued" });
    expect(await client.runAhead(second)).toMatchObject({ runId: first, status: "waiting" });
    expect(await client.runAhead(first)).toBeUndefined();
    // Nothing can run until the lead decides: the queued run cannot start before the waiting one ends.
    expect(await worker.idle()).toBe(true);

    await approve(first);
    expect(await client.result(first)).toBe(1);
    await waitFor(pending(() => client, second));
    expect(await recordAt(second, "run.started")).toBeGreaterThanOrEqual(await recordAt(first, "run.finished"));
    await approve(second);
    expect(await client.result(second)).toBe(2);
  });

  it("makes an agent's run for a person wait for that person's own, and the reverse", async () => {
    const hers = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, hers));
    const its = await client.start(openBox, { n: 2 }, { startedBy: botForAlice });
    expect(await stillQueued(raw, its)).toBe(true);
    expect(await client.runAhead(its)).toMatchObject({ runId: hers, status: "waiting" });
    const againHers = await client.start(openBox, { n: 3 }, { startedBy: alice });
    expect(await stillQueued(raw, againHers)).toBe(true);
    expect(await client.runAhead(againHers)).toMatchObject({ runId: hers });

    await approve(hers);
    expect(await client.result(hers)).toBe(1);
    // The agent's, started first, goes next: held at its start for admin, it keeps the place.
    await waitFor(pending(() => client, its));
    expect(await stillQueued(raw, againHers)).toBe(true);
    expect(await client.runAhead(againHers)).toMatchObject({ runId: its });
  });

  it("lets the next run start once the one ahead fails", async () => {
    const failing = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, failing));
    const next = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, next)).toBe(true);
    // Rejected, its approval fails the run.
    await client.decide(failing, { decision: "reject", by: lead });
    await waitFor(async () => (await client.run(failing))?.status === "failed");
    await waitFor(pending(() => client, next));
  });

  it("lets the next run start once the one ahead is cancelled", async () => {
    const cancelled = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, cancelled));
    const next = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, next)).toBe(true);
    await raw.cancelWorkflow(cancelled);
    await waitFor(pending(() => client, next));
    expect(await client.run(cancelled)).toMatchObject({ status: "cancelled" });
  });

  it("refuses an anonymous start: every visitor not signed in is one anonymous", async () => {
    await expect(client.start(openBox, { n: 1 }, { startedBy: "anonymous" })).rejects.toMatchObject({
      code: "policy_denied",
      message: expect.stringMatching(/runs one per person, so its starter must be signed in/),
    });
  });

  it("never makes another person's run wait", async () => {
    const hers = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, hers));
    const his = await client.start(openBox, { n: 2 }, { startedBy: bob });
    await waitFor(pending(() => client, his));
    expect(await client.runAhead(his)).toBeUndefined();
    await Promise.all([approve(hers), approve(his)]);
    expect(await Promise.all([client.result(hers), client.result(his)])).toEqual([1, 2]);
  });

  it("keeps the order across a worker's restart: the first resumes, the second still waits for it", async () => {
    const first = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, first));
    const second = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, second)).toBe(true);

    await worker.stop();
    worker = await startTestWorker(config, { databaseUrl });
    // Recovery queues the first again in its place, ahead of the second, which goes on waiting.
    await waitFor(async () => (await row(first))?.status === "PENDING");
    expect(await stillQueued(raw, second)).toBe(true);
    expect(await client.runAhead(second)).toMatchObject({ runId: first });

    await approve(first);
    expect(await client.result(first)).toBe(1);
    await waitFor(pending(() => client, second));
    await approve(second);
    expect(await client.result(second)).toBe(2);
  });

  it("keeps the place of a start held for an approval, until it is decided and its run ends", async () => {
    const held = await client.start(openBox, { n: 1 }, { startedBy: wary });
    await waitFor(pending(() => client, held));
    expect(await row(held)).toMatchObject({ status: "PENDING", queueName: resolved.perPersonQueueName });
    const behind = await client.start(openBox, { n: 2 }, { startedBy: wary });
    expect(await stillQueued(raw, behind)).toBe(true);
    expect(await client.runAhead(behind)).toMatchObject({ runId: held, status: "waiting" });

    await approve(held);
    await waitFor(pending(() => client, held, 2));
    expect(await stillQueued(raw, behind)).toBe(true);
    await approve(held);
    expect(await client.result(held)).toBe(1);
    await waitFor(pending(() => client, behind));
  });
});

describe("a new version's worker", () => {
  const databaseUrl = freshDatabase("one-per-person-deploy");
  const root = rootWith({ "resources/people.ts": PEOPLE, "policies/policy.cedar": POLICY });
  const v1: SanomaConfig = { workflows: [openBox], connectors: [], ledger: memoryLedger(), root, databaseUrl };
  // Other code, so another version: one more workflow.
  const later = defineWorkflow({
    name: "later",
    trigger: "manual",
    input: z.object({}),
    uses: [],
    run: async () => {},
  });
  const v2: SanomaConfig = { ...v1, workflows: [openBox, later] };
  const workers: Worker[] = [];
  let client: SanomaClient;
  let raw: DBOSClient;
  beforeAll(async () => {
    client = await SanomaClient.connect(v1);
    raw = await dbosClient(databaseUrl);
  });
  afterAll(async () => {
    await raw?.destroy();
    await client?.close();
    await Promise.all(workers.map((w) => w.stop()));
  });

  it("cancels a run of the old code holding a person's place, so the run queued behind it without a version starts", async () => {
    const old = await startTestWorker(v1, { databaseUrl });
    // The local app's client queues with no version: the latest version's worker runs it.
    const first = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, first));
    const second = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, second)).toBe(true);
    expect(await raw.getWorkflow(second)).toMatchObject({ applicationVersion: null });
    await old.stop();

    workers.push(await startTestWorker(v2, { databaseUrl, promote: true }));
    await waitFor(async () => (await raw.getWorkflow(first))?.status === "CANCELLED");
    await waitFor(pending(() => client, second));
    expect(await raw.getWorkflow(second)).toMatchObject({ applicationVersion: resolveConfig(v2).version });
    await client.decide(second, { decision: "approve", by: lead });
    expect(await client.result(second)).toBe(2);
  });
});

describe("queueFor", () => {
  const scope = {
    applyQueueName: "sanoma:acme:apply",
    perPersonQueueName: "sanoma:acme:per-person",
    workflows: new Map([[openBox.name, openBox]]),
  };
  const place = (startedBy: Principal, { version = "v1", sandbox }: { version?: string; sandbox?: string } = {}) =>
    queueFor(scope, openBox.name, { startedBy, ...(sandbox !== undefined && { sandbox }) }, version);

  it("keys a run by its version, workflow and the person it is for, an agent's by the person it acts for", () => {
    expect(place(alice)).toEqual({
      queueName: scope.perPersonQueueName,
      queuePartitionKey: JSON.stringify(["v1", "open-box", "alice"]),
    });
    expect(place({ id: "alice", groups: ["staff"] })).toEqual(place(alice));
    expect(place(botForAlice)).toEqual(place(alice));
    expect(place({ id: "chat", onBehalfOf: "alice" })).toEqual(place(alice));
    const keys = [place(alice), place(bob), place(alice, { version: "v2" }), place({ id: "bot" })].map(
      (p) => p?.queuePartitionKey,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves a sandbox run, and a workflow without the option, to the app's queue", () => {
    expect(place(alice, { sandbox: "A scenario" })).toBeUndefined();
    expect(queueFor(scope, "other", { startedBy: alice }, "v1")).toBeUndefined();
  });

  it("is refused with a schedule, and for any other value", () => {
    const def = { name: "nightly", input: z.object({}), uses: [], run: async () => {} } as const;
    expect(() => defineWorkflow({ ...def, trigger: { schedule: "0 3 * * *" }, concurrency: "one per person" })).toThrow(
      /a schedule's runs are the runtime's/,
    );
    expect(() => defineWorkflow({ ...def, trigger: "manual", concurrency: "always" as never })).toThrow(
      /concurrency is "one per person"/,
    );
  });
});
