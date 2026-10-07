import { randomUUID } from "node:crypto";
import { fakeMarketingVendors } from "@sanoma/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import announce from "../../../examples/marketing/workflows/announce.ts";
import { SanomaClient, startWorker, type Worker } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = process.env.SANOMA_TEST_DATABASE_URL ?? "postgresql://postgres:dbos@localhost:5433/sanoma_test";
const appName = "sanoma-test";
const vendors = fakeMarketingVendors();
let worker: Worker;
let client: SanomaClient;

const start = () => startWorker({ workflows: [announce], drivers: vendors.drivers, databaseUrl, appName });
const ops = () => vendors.state.calls.map((c) => c.op);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pending = (runId: string) => async () => (await client.approvals(runId)).some((a) => a.status === "pending");

beforeAll(async () => {
  worker = await start();
  client = await SanomaClient.connect(databaseUrl, appName);
});

afterAll(async () => {
  await client?.close();
  await worker?.stop();
});

beforeEach(() => vendors.reset());

describe("announce", () => {
  it("drafts, waits for the named approver, sleeps until launch, then publishes", async () => {
    const launchAt = inSeconds(3);
    const runId = await client.start(
      announce,
      { title: "Acme Pro is here", body: "<p>Hello</p>", launchAt },
      randomUUID(),
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

  it("finishes after the worker is stopped and restarted mid-sleep, without repeating a step", async () => {
    const launchAt = inSeconds(4);
    const runId = await client.start(announce, { title: "Restart", body: "<p>x</p>", launchAt }, randomUUID());
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
  });

  it("stops before publishing anything when the approver rejects", async () => {
    const runId = await client.start(
      announce,
      { title: "Nope", body: "<p>x</p>", launchAt: inSeconds(1) },
      randomUUID(),
    );
    await waitFor(pending(runId));
    await client.decide(runId, { decision: "reject", by: "marketing-lead", note: "wrong date" });

    await expect(client.result(runId)).rejects.toThrow(/rejected by marketing-lead: wrong date/);
    expect(ops()).toEqual(["ghost.post.create", "resend.broadcast.create"]);
    expect((await client.run(runId))?.status).toBe("ERROR");
  });

  it("refuses input that doesn't match the workflow's schema before queueing", async () => {
    await expect(client.start(announce, { title: "", body: "x", launchAt: "tomorrow" })).rejects.toThrow(/launchAt/);
  });
});
