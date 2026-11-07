import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../src/index.ts";
import { types, useApp, waitFor } from "./harness.ts";

const alice = { id: "alice" };

/** Whether a run has begun, and the wait of the one that did. */
let entered = false;
let wait = Promise.withResolvers<string>();

// Its first execution waits; any after it finishes.
const waits = defineWorkflow({
  name: "waits",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => {
    if (entered) return "finished";
    entered = true;
    return wait.promise;
  },
});

describe("a worker's stop", () => {
  const app = useApp("stop_interrupt", () => ({ workflows: [waits] }));
  beforeEach(() => {
    entered = false;
    wait = Promise.withResolvers();
  });

  /**
   * Stops the worker, doing `during` with it marked stopped and DBOS's pool still open, then
   * leaving the pool open long enough for a write DBOS must not make.
   */
  const stopWith = async (during: () => void | Promise<void>) => {
    const shutdown = DBOS.shutdown.bind(DBOS);
    vi.spyOn(DBOS, "shutdown").mockImplementationOnce(async (...args) => {
      await during();
      await delay(500);
      return shutdown(...args);
    });
    await app.stop();
  };

  /** What a next worker makes of a run: its result, and the ledger's record of it. */
  const afterRestart = async (runId: string) => {
    await app.restart();
    return { result: await app.client.result(runId), records: types(await app.client.ledger(runId)) };
  };
  const finishedByTheNextWorker = { result: "finished", records: ["run.started", "run.finished"] };

  it("leaves a run whose wait fails with the stop for the next worker", async () => {
    const runId = await app.client.start(waits, {}, { startedBy: alice });
    await waitFor(() => entered);
    await stopWith(() => wait.reject(new Error("The system database has been shut down")));
    expect(await afterRestart(runId)).toEqual(finishedByTheNextWorker);
  });

  it("leaves a run DBOS dispatches during the stop for the next worker", async () => {
    entered = true;
    let runId = "";
    await stopWith(async () => {
      runId = await app.client.start(waits, {}, { startedBy: alice });
      await waitFor(async () => (await app.client.run(runId))?.status !== "queued");
    });
    expect(await afterRestart(runId)).toEqual(finishedByTheNextWorker);
  });
});
