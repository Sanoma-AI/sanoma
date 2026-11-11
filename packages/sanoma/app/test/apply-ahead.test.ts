import type { RunSummary, SanomaClient } from "sanoma/workflows";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/context.ts";
import { runDetail } from "../src/server/core.ts";
import { goLiveRunOf } from "../src/server/go-live.ts";

// The apply a queued apply waits for, as Hosting and the run's page are given it: asked of the
// client (`applyAhead`) for a queued apply only, and cut to what the page names.

const run = (s: Partial<RunSummary>): RunSummary =>
  ({ runId: "r2", workflow: "apply", status: "queued", approvals: [], createdAt: 2, ...s }) as RunSummary;
const first = run({
  runId: "r1",
  status: "waiting",
  startedBy: { id: "careful" },
  createdAt: 1,
  approvals: [{ id: "a" } as never],
});
const ahead = { runId: "r1", status: "waiting", startedBy: { id: "careful" }, createdAt: 1 };

/** A client whose `run` is `r`, with nothing recorded, and `first` ahead of any apply. */
const clientOf = (r: RunSummary) => {
  const applyAhead = vi.fn<SanomaClient["applyAhead"]>(async () => first);
  const client = { run: async () => r, ledger: async () => [], runChecks: async () => undefined, applyAhead };
  return client as unknown as SanomaClient & { applyAhead: typeof applyAhead };
};
const contextOf = (client: SanomaClient) =>
  ({ client, snapshot: { scenarios: { scenarios: [] } } }) as unknown as AppContext;

describe("the apply ahead", () => {
  it("is given for a queued apply, on Hosting and on its page, with only what the page names", async () => {
    const client = clientOf(run({}));
    expect(await goLiveRunOf(client, run({}))).toEqual({ runId: "r2", workflow: "apply", status: "queued", ahead });
    expect(await runDetail(contextOf(client), "r2")).toMatchObject({ ahead });
    expect(client.applyAhead).toHaveBeenCalledWith("r2");
  });

  it("is not asked for a run that is not a queued apply", async () => {
    for (const r of [run({ status: "running" }), run({ workflow: "drift" })]) {
      const client = clientOf(r);
      expect(await goLiveRunOf(client, r)).not.toHaveProperty("ahead");
      expect(await runDetail(contextOf(client), r.runId)).not.toHaveProperty("ahead");
      expect(client.applyAhead).not.toHaveBeenCalled();
    }
  });
});
