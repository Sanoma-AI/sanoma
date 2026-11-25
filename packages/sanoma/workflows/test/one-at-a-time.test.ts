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

// Needs Postgres: `pnpm db:up`. A workflow with `oneAtATime: "per starter"` runs each starter's
// runs one after another, on DBOS's partitioned queue: a second run of alice's waits, queued, for
// her first to end, and names it as the one ahead; bob's never waits for hers; the order holds
// across a worker's restart, and a start held for an approval keeps its place.

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice" });
export const bob = sanoma.person({ id: "bob" });
export const wary = sanoma.person({ id: "wary" });
export const lead = sanoma.person({ id: "lead" });
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
  oneAtATime: "per starter",
  run: async (ctx, { n }) => {
    await ctx.approval("Open it?", { approver: "lead" });
    return n;
  },
});

const alice: Principal = { id: "alice" };
const bob: Principal = { id: "bob" };
const wary: Principal = { id: "wary" };
const lead = { id: "lead" };

describe("one run at a time per starter", () => {
  const databaseUrl = freshDatabase("one-at-a-time");
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
    const queue = (await raw.listQueues(resolved.appName)).find((q) => q.name === resolved.oneAtATimeQueueName);
    expect(resolved.oneAtATimeQueueName).toBe(`sanoma:${resolved.appName}:one-at-a-time`);
    expect(queue?.partitionConcurrency).toBe(1);
  });

  it("starts a starter's second run only once the first ends, naming the first as the one ahead", async () => {
    const first = await client.start(openBox, { n: 1 }, { startedBy: alice });
    await waitFor(pending(() => client, first));
    const second = await client.start(openBox, { n: 2 }, { startedBy: alice });
    expect(await stillQueued(raw, second)).toBe(true);
    expect(await row(second)).toMatchObject({ queueName: resolved.oneAtATimeQueueName });
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

  it("never makes another starter's run wait", async () => {
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
    expect(await row(held)).toMatchObject({ status: "PENDING", queueName: resolved.oneAtATimeQueueName });
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

describe("queueFor", () => {
  const scope = {
    applyQueueName: "sanoma:acme:apply",
    oneAtATimeQueueName: "sanoma:acme:one-at-a-time",
    workflows: new Map([[openBox.name, openBox]]),
  };
  const place = (startedBy: Principal, { version = "v1", sandbox }: { version?: string; sandbox?: string } = {}) =>
    queueFor(scope, openBox.name, { startedBy, ...(sandbox !== undefined && { sandbox }) }, version);

  it("keys a run by its version, workflow and starter, an agent with the person it acts for", () => {
    expect(place(alice)).toEqual({
      queueName: scope.oneAtATimeQueueName,
      queuePartitionKey: JSON.stringify(["v1", "open-box", "alice", null]),
    });
    expect(place({ id: "alice", groups: ["staff"] })).toEqual(place(alice));
    const keys = [
      place(alice),
      place(bob),
      place(alice, { version: "v2" }),
      place({ id: "bot", onBehalfOf: "alice" }),
      place({ id: "bot", onBehalfOf: "bob" }),
    ].map((p) => p?.queuePartitionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves a sandbox run, and a workflow without the option, to the app's queue", () => {
    expect(place(alice, { sandbox: "A scenario" })).toBeUndefined();
    expect(queueFor(scope, "other", { startedBy: alice }, "v1")).toBeUndefined();
  });

  it("is refused with a schedule, and for any other value", () => {
    const def = { name: "nightly", input: z.object({}), uses: [], run: async () => {} } as const;
    expect(() => defineWorkflow({ ...def, trigger: { schedule: "0 3 * * *" }, oneAtATime: "per starter" })).toThrow(
      /a schedule's runs are the runtime's/,
    );
    expect(() => defineWorkflow({ ...def, trigger: "manual", oneAtATime: "always" as never })).toThrow(
      /oneAtATime is "per starter"/,
    );
  });
});
