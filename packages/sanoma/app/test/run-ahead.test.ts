import type { RunSummary, SanomaClient } from "sanoma/workflows";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/context.ts";
import { runCatalog } from "../src/server/catalog.ts";
import { type CallHost, runDetail } from "../src/server/core.ts";
import { goLiveRunOf } from "../src/server/go-live.ts";

// The run a queued run waits for, as Hosting and the run's page are given it: asked of the client
// (`runAhead`: an apply, or the starter's run ahead of a workflow with `oneAtATime`) for a queued
// run only, and cut to what the page names.

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

/** A client whose `run` is `r`, with nothing recorded, and `first` ahead of any queued run. */
const clientOf = (r: RunSummary) => {
  const runAhead = vi.fn<SanomaClient["runAhead"]>(async () => first);
  const client = { run: async () => r, ledger: async () => [], runChecks: async () => undefined, runAhead };
  return client as unknown as SanomaClient & { runAhead: typeof runAhead };
};
const contextOf = (client: SanomaClient) =>
  ({ client, snapshot: { scenarios: { scenarios: [] } } }) as unknown as AppContext;

describe("the run ahead", () => {
  it("is given for a queued apply, on Hosting and on its page, with only what the page names", async () => {
    const client = clientOf(run({}));
    expect(await goLiveRunOf(client, run({}))).toEqual({ runId: "r2", workflow: "apply", status: "queued", ahead });
    expect(await runDetail(contextOf(client), "r2")).toMatchObject({ ahead });
    expect(client.runAhead).toHaveBeenCalledWith("r2");
  });

  it("is given on its page for a queued run of a company workflow, which waits for its starter's", async () => {
    const queued = run({ workflow: "open-box" });
    const client = clientOf(queued);
    expect(await runDetail(contextOf(client), "r2")).toMatchObject({ ahead });
  });

  it("is not asked for a run that is not queued", async () => {
    for (const r of [run({ status: "running" }), run({ workflow: "drift", status: "finished" })]) {
      const client = clientOf(r);
      expect(await goLiveRunOf(client, r)).not.toHaveProperty("ahead");
      expect(await runDetail(contextOf(client), r.runId)).not.toHaveProperty("ahead");
      expect(client.runAhead).not.toHaveBeenCalled();
    }
  });

  it("is named over /mcp: get_run's after, and wait_run's answer of a run still queued", async () => {
    const queued = run({ workflow: "open-box", startedBy: { id: "ada" } });
    const host = {
      client: clientOf(queued),
      resolved: { ops: new Map(), workflows: new Map() },
      snapshot: { description: { workflows: [{ name: "open-box" }] } },
    } as unknown as CallHost;
    const actor = { id: "ada" };
    expect(await runCatalog(host, "get_run", { runId: "r2" }, { actor })).toMatchObject({
      runId: "r2",
      status: "queued",
      after: "r1",
    });
    expect(await runCatalog(host, "wait_run", { runId: "r2", waitMs: 0 }, { actor })).toEqual({
      runId: "r2",
      status: "queued",
      after: "r1",
    });
  });
});
