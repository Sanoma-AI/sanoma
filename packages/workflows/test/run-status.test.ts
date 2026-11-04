import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { lazyPool, type Db } from "../src/db.ts";
import {
  defineConnector,
  defineDriver,
  defineWorkflow,
  DriverError,
  memorySecrets,
  sanoma,
  withSetup,
} from "../src/index.ts";
import { inspectRun } from "../src/run-status.ts";
import { runtimeDriver, sandboxRuntimeDriver } from "../src/runtime-ops.ts";
import { memoryTokens } from "../src/tokens.ts";
import { rootWith } from "./harness.ts";

const observe = defineWorkflow({
  name: "observe-run",
  trigger: "manual",
  input: z.object({ runId: z.string() }),
  uses: [sanoma.run.inspect],
  run: async (ctx, input) => await ctx.sanoma.run.inspect(input),
});
const targetInput = z.object({ marker: z.string(), fail: z.boolean() });
const testOps = defineConnector("inspectiontest", {
  target: { read: { effect: "read", idempotent: true, input: targetInput, output: z.string(), target: () => "test" } },
});
const testConnector = withSetup(testOps, {
  driver: () =>
    defineDriver(testOps, {
      target: {
        read: async (input) => {
          if (input.fail) throw new DriverError(input.marker, { retryable: false });
          return input.marker;
        },
      },
    }),
});
const target = defineWorkflow({
  name: "target-run",
  trigger: "manual",
  input: targetInput,
  uses: [testOps.target.read],
  run: async (ctx, input) => await ctx.inspectiontest.target.read(input),
});
const waiting = defineWorkflow({
  name: "waiting-run",
  trigger: "manual",
  input: z.object({}),
  uses: ["approval"],
  run: async (ctx) => await ctx.approval("Wait", { approver: "operator" }),
});
const databaseUrl = testDatabaseUrl("run_status");
const pool = lazyPool(databaseUrl, "run-status-test");
afterAll(() => pool.close());
const root = rootWith({
  "policies/policy.cedar": `forbid (principal, action == Sanoma::Action::"sanoma.run.inspect", resource)
when { context.input.runId == "forbidden" };`,
});
const app = useTestApp({ workflows: [observe, target, waiting], connectors: [testConnector], root }, { databaseUrl });
const actor = { id: "operator" };

describe("run inspection through the runtime", () => {
  it.each([false, true])("returns terminal metadata without input/output/error (failed: %s)", async (fail) => {
    const marker = `sensitive-target-${randomUUID()}`;
    const runId = await app.client.start(target, { marker, fail }, { startedBy: actor });
    const result = await app.client.result(runId).then(
      (value) => ({ ok: true, value }),
      () => ({ ok: false }),
    );
    expect(result).toEqual(fail ? { ok: false } : { ok: true, value: marker });
    const inspection = await app.client.start(observe, { runId }, { startedBy: actor });
    expect(await app.client.result(inspection)).toEqual({
      runId,
      workflow: "target-run",
      status: fail ? "failed" : "finished",
    });
    expect(JSON.stringify(await app.client.ledger(inspection))).not.toContain(marker);
    const db = await pool.db();
    const { rows } = await db.query("SELECT * FROM dbos.operation_outputs WHERE workflow_uuid=$1", [inspection]);
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it("keeps an approval wait active and refuses to infer completion for missing runs", async () => {
    const runId = await app.client.start(waiting, {}, { startedBy: actor });
    expect(await app.client.call("sanoma.run.inspect", { runId }, { actor })).toEqual({
      runId,
      workflow: "waiting-run",
      status: "active",
    });
    const missing = randomUUID();
    expect(await app.client.call("sanoma.run.inspect", { runId: missing }, { actor })).toEqual({
      runId: missing,
      status: "missing",
    });
  });

  it("does not expose a different application's run in the same database", async () => {
    const runId = await app.client.start(target, { marker: "other-application", fail: false }, { startedBy: actor });
    await app.client.result(runId);
    const db = await pool.db();
    const { rows } = await db.query<{ application_name: string }>(
      "SELECT application_name FROM dbos.workflow_status WHERE workflow_uuid=$1",
      [runId],
    );
    await db.query("UPDATE dbos.workflow_status SET application_name=$2 WHERE workflow_uuid=$1", [
      runId,
      "other-application",
    ]);
    try {
      expect(await app.client.call("sanoma.run.inspect", { runId }, { actor })).toEqual({ runId, status: "missing" });
    } finally {
      await db.query("UPDATE dbos.workflow_status SET application_name=$2 WHERE workflow_uuid=$1", [
        runId,
        rows[0]!.application_name,
      ]);
    }
  });

  it("enforces policy before inspection", async () => {
    await expect(app.client.call("sanoma.run.inspect", { runId: "forbidden" }, { actor })).rejects.toMatchObject({
      code: "policy_denied",
    });
  });
});

describe("inspection failure and sandbox boundaries", () => {
  const call = {
    idempotencyKey: "test:1",
    runId: "test",
    opId: "sanoma.run.inspect",
    attempt: 1,
    secrets: memorySecrets(),
  };
  it("sanitizes database errors instead of declaring the owner missing or finished", async () => {
    const driver = runtimeDriver({
      tokens: memoryTokens(),
      inspect: async () => {
        throw new Error("sensitive database URL");
      },
    });
    await expect(driver.ops["run.inspect"]!({ runId: "owner" }, call)).rejects.toMatchObject({
      message: "Run inspection unavailable",
      retryable: true,
    });
  });
  it("never queries live run state from a sandbox", async () => {
    expect(await sandboxRuntimeDriver().ops["run.inspect"]!({ runId: "live-owner" }, call)).toEqual({
      runId: "live-owner",
      status: "missing",
    });
  });
  it("distinguishes exhausted recovery from an ordinary failed execution", async () => {
    const query = vi
      .fn<(sql: string, values: unknown[]) => Promise<{ rows: { name: string; status: string }[] }>>()
      .mockResolvedValue({ rows: [{ name: "owner", status: "MAX_RECOVERY_ATTEMPTS_EXCEEDED" }] });
    expect(await inspectRun(async () => ({ query }) as unknown as Db, "company")("owner-id")).toEqual({
      runId: "owner-id",
      workflow: "owner",
      status: "interrupted",
    });
  });
  it("treats future DBOS states as active, without loading payload columns", async () => {
    const query = vi
      .fn<(sql: string, values: unknown[]) => Promise<{ rows: { name: string; status: string }[] }>>()
      .mockResolvedValue({ rows: [{ name: "owner", status: "FUTURE_STATE" }] });
    expect(await inspectRun(async () => ({ query }) as unknown as Db, "company")("owner-id")).toEqual({
      runId: "owner-id",
      workflow: "owner",
      status: "active",
    });
    expect(query).toHaveBeenCalledWith(
      "SELECT name,status FROM dbos.workflow_status WHERE workflow_uuid=$1 AND application_name=$2",
      ["owner-id", "company"],
    );
  });
});
