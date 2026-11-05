import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../src/index.ts";
import { useApp, waitFor } from "./harness.ts";

const alice = { id: "alice" };

/** Whether a run has begun, and how to fail the wait of the one that did. */
const first: { entered: boolean; fail?: (err: Error) => void } = { entered: false };

// Its first execution waits; any after it finishes.
const waits = defineWorkflow({
  name: "waits",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => {
    if (first.entered) return "finished";
    first.entered = true;
    return new Promise<string>((_, reject) => {
      first.fail = reject;
    });
  },
});

describe("a worker's stop", () => {
  const app = useApp("stop_interrupt", () => ({ workflows: [waits] }));
  beforeEach(() => {
    first.entered = false;
  });

  /** Stops the worker, doing `during` with it marked stopped and DBOS's pool still open, where DBOS's writes land. */
  const stopWith = async (during: () => void | Promise<void>) => {
    const shutdown = DBOS.shutdown.bind(DBOS);
    const spy = vi.spyOn(DBOS, "shutdown").mockImplementationOnce(async (...args) => {
      await during();
      await delay(500);
      return shutdown(...args);
    });
    await app.stop();
    spy.mockRestore();
  };

  /** What became of a run: whether the stop failed it, then its result and failures once a next worker has had it. */
  const afterRestart = async (runId: string) => {
    const failedByStop = (await app.client.run(runId))?.status === "failed";
    await app.restart();
    const result = await app.client.result(runId);
    return { failedByStop, result, failures: (await app.client.ledger(runId)).filter((r) => r.type === "run.failed") };
  };
  const leftForTheNextWorker = { failedByStop: false, result: "finished", failures: [] };

  it("leaves a run whose wait fails with the stop for the next worker", async () => {
    const runId = await app.client.start(waits, {}, { startedBy: alice });
    await waitFor(() => first.entered);
    await stopWith(() => first.fail!(new Error("The system database has been shut down")));
    expect(await afterRestart(runId)).toEqual(leftForTheNextWorker);
  });

  it("leaves a run DBOS dispatches during the stop for the next worker", async () => {
    first.entered = true;
    let runId = "";
    await stopWith(async () => {
      runId = await app.client.start(waits, {}, { startedBy: alice });
    });
    expect(await afterRestart(runId)).toEqual(leftForTheNextWorker);
  });
});
