import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runStatus } from "../src/client.ts";
import { type ApprovalState, defineWorkflow, errorCode, SanomaClient } from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("client");
const alice = { id: "alice" };
const lead = { id: "marketing-lead" };
const input = { title: "Client", body: "<p>x</p>", launchAt: inSeconds(1) };

const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

const approval = (status: ApprovalState["status"]) => ({ status }) as ApprovalState;

describe("runStatus", () => {
  it("maps DBOS statuses, and a running run with an approval pending to waiting", () => {
    expect(runStatus("ENQUEUED", [])).toBe("queued");
    expect(runStatus("DELAYED", [])).toBe("queued");
    expect(runStatus("PENDING", [])).toBe("running");
    expect(runStatus("PENDING", [approval("approved")])).toBe("running");
    expect(runStatus("PENDING", [approval("approved"), approval("pending")])).toBe("waiting");
    expect(runStatus("SUCCESS", [])).toBe("finished");
    expect(runStatus("ERROR", [approval("rejected")])).toBe("failed");
    expect(runStatus("MAX_RECOVERY_ATTEMPTS_EXCEEDED", [])).toBe("failed");
    expect(runStatus("CANCELLED", [approval("pending")])).toBe("cancelled");
    expect(runStatus("SOMETHING_NEW", [])).toBe("running");
  });
});

describe("SanomaClient", () => {
  const app = useApp(databaseUrl, "client");
  const c = () => app.client;

  it("refuses input the workflow's schema refuses, with invalid_input and zod's issues, before queueing", async () => {
    const before = (await c().runs({ limit: 1 }))[0]?.runId;
    const err = await caught(c().start(announce, { ...input, launchAt: "tomorrow" }, { startedBy: alice }));
    expect(errorCode(err)).toBe("invalid_input");
    expect(err).toMatchObject({
      message: expect.stringMatching(/launchAt/),
      data: { issues: [expect.objectContaining({ path: ["launchAt"], message: expect.any(String) })] },
    });
    expect((await c().runs({ limit: 1 }))[0]?.runId).toBe(before);
  });

  it("requires a principal to start a run as", async () => {
    const err = await caught(c().start(announce, input, { startedBy: { id: " " } }));
    expect(errorCode(err)).toBe("invalid_input");
    expect(err).toMatchObject({ data: { issues: [expect.objectContaining({ path: ["id"] })] } });
    const missing = await caught(c().start(announce, input, {} as never));
    expect(errorCode(missing)).toBe("invalid_input");
  });

  it("says run_not_found for a run that does not exist, rather than waiting on it or reading no records", async () => {
    // A decision for a missing run: approvals.test.ts.
    const missing = randomUUID();
    for (const call of [() => c().result(missing), () => c().ledger(missing)]) {
      const err = await caught(call());
      expect(errorCode(err)).toBe("run_not_found");
      expect(err).toMatchObject({ message: `No run ${missing}`, data: { runId: missing } });
    }
    expect(await c().run(missing)).toBeUndefined();
  });

  it("lists the app's runs with their status and who started them", async () => {
    const runId = await c().start(announce, input, { startedBy: { id: "bob", groups: ["ops", "marketing"] } });
    await waitFor(pending(c, runId));
    const [listed] = (await c().runs({ limit: 50 })).filter((r) => r.runId === runId);
    expect(listed).toMatchObject({
      workflow: "announce",
      status: "waiting",
      startedBy: { id: "bob", groups: ["ops", "marketing"] },
      approvals: [expect.objectContaining({ id: "approval-1", status: "pending" })],
    });
    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect((await c().run(runId))?.status).toBe("finished");
  });

  it("lists runs by status: one waiting on an approval, and not once it has finished", async () => {
    const runId = await c().start(announce, input, { startedBy: alice });
    await waitFor(pending(c, runId));
    const waiting = await c().runs({ status: "waiting" });
    expect(waiting.map((r) => r.runId)).toContain(runId);
    expect(waiting.every((r) => r.status === "waiting")).toBe(true);
    expect((await c().runs({ status: "running" })).map((r) => r.runId)).not.toContain(runId);

    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect((await c().runs({ status: "waiting" })).map((r) => r.runId)).not.toContain(runId);
    const finished = await c().runs({ status: "finished", limit: 50 });
    expect(finished.map((r) => r.runId)).toContain(runId);
    expect(finished.every((r) => r.status === "finished")).toBe(true);
  });

  it("checks the config on connect, the way the worker does", async () => {
    await expect(SanomaClient.connect({ ...app.config, policy: undefined as never })).rejects.toThrow(
      "The config needs a `policy`; use `allowAll` to allow every operation call",
    );
  });
});

/** Its schema changes the value it parses, so parsing it twice would fail every run. */
const double = defineWorkflow({
  name: "double",
  trigger: "manual",
  input: z.object({ n: z.string().transform(Number) }),
  uses: [],
  run: async (_ctx, { n }) => n * 2,
});

describe("a workflow whose input schema transforms", () => {
  const app = useApp(databaseUrl, "client-transform", () => ({ workflows: [double] }));
  const c = () => app.client;

  it("parses the input once, in the worker, and records it as the caller sent it", async () => {
    const runId = await c().start(double, { n: "21" }, { startedBy: alice });
    expect(await c().result(runId)).toBe(42);
    expect((await c().ledger(runId))[0]).toMatchObject({ type: "run.started", input: { n: "21" } });
  });

  it("returns the run a run id names when started again the same way, and refuses another input or actor", async () => {
    const runId = `double-${randomUUID()}`;
    expect(await c().start(double, { n: "2" }, { startedBy: alice, runId })).toBe(runId);
    expect(await c().result(runId)).toBe(4);
    expect(await c().start(double, { n: "2" }, { startedBy: { id: "alice" }, runId })).toBe(runId);

    const otherInput = await caught(c().start(double, { n: "3" }, { startedBy: alice, runId }));
    expect(errorCode(otherInput)).toBe("invalid_input");
    expect(otherInput).toMatchObject({
      message: `Run ${runId} already exists with a different input; use another run id`,
      data: { runId, differs: ["input"] },
    });
    const actor = await caught(c().start(double, { n: "2" }, { startedBy: { id: "bob" }, runId }));
    expect(actor).toMatchObject({ data: { differs: ["startedBy"] } });
    expect((await c().ledger(runId)).filter((r) => r.type === "run.started")).toHaveLength(1);
  });
});
