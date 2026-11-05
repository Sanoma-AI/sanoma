import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../src/index.ts";
import { useApp, waitFor } from "./harness.ts";

const alice = { id: "alice" };

/** The run's first execution: inside its body until `fail` ends it. */
const first: { entered: boolean; fail?: (err: Error) => void } = { entered: false };

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

  it("leaves a run it interrupted for the next worker, not failed", async () => {
    const runId = await app.client.start(waits, {}, { startedBy: alice });
    await waitFor(() => first.entered);

    // A wait fails as `DBOS.recv` does when the system database is shut down and its pool is
    // still open: under load DBOS's own write of that error then lands, and ends the run for good.
    const shutdown = DBOS.shutdown.bind(DBOS);
    vi.spyOn(DBOS, "shutdown").mockImplementationOnce(async (...args) => {
      first.fail!(new Error("The system database has been shut down"));
      await delay(500);
      return shutdown(...args);
    });
    await app.stop();

    expect((await app.client.run(runId))?.status).not.toBe("failed");
    await app.restart();
    expect(await app.client.result(runId)).toBe("finished");
    expect((await app.client.ledger(runId)).filter((r) => r.type === "run.failed")).toEqual([]);
  });
});
