import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallContext,
  memoryLedger,
  memorySecrets,
  SanomaClient,
  type SanomaConfig,
  shouldWake,
} from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl, waitFor } from "../src/index.ts";
import { fakeHost, hostCheck, inProcessHost } from "../src/host.ts";
import { fakeWakeup, wakeupCheckWorkflows } from "../src/wakeup.ts";

// Needs Postgres: `pnpm db:up`. Scale to zero end to end, on fakes and no account: a host that
// stops when its process exits, running the company in this process as `sanoma serve` does (a
// worker under its supervisor), the fake wakeup applied for it, a sleeping run and a schedule.
// The worker stops itself when idle and registers its next deadline; the process stops; a wake
// starts it again; the worker stops again, and a wake starts a fresh one in the same process.
const databaseUrl = testDatabaseUrl("wakeup_stack");
const INFRA = "resources/infra.ts";

const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${Date.now()}`,
  runId: "stack",
  opId,
  attempt: 1,
  secrets: memorySecrets({}),
});

describe("scale to zero, the stack on fakes", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-wakeup-stack-"));
  // An app of its own each run: its schedule is new, so no tick of an earlier run's is fired.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: `wakeup-stack-${Date.now()}` }));
  mkdirSync(join(root, "resources"));
  writeFileSync(
    join(root, INFRA),
    [
      'import { testhost } from "@sanoma-ai/testing-host/resources";',
      'import { testwakeup } from "@sanoma-ai/testing-wakeup/resources";',
      "",
      'export const app = testhost.app({ name: "company", source: "file:///unused.git", ref: "main", port: 0 });',
      'export const wake = testwakeup.timer({ name: "wake", host: app });',
      "",
    ].join("\n"),
  );
  const config: SanomaConfig = {
    workflows: [...wakeupCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  // Idle once nothing is due within a second, looked at four times a second: the schedule's next
  // tick is never more than a minute away, the default horizon.
  const host = fakeHost(inProcessHost(config, databaseUrl, { idleHorizonMs: 1_000, stopCheckMs: 250 }), {
    lifetime: "stops-on-exit",
  });
  const wakeup = fakeWakeup();
  config.connectors.push(host.connector, wakeup.connector);
  let client: SanomaClient;
  let url: string;

  beforeAll(async () => {
    const desired = { name: "company", source: "file:///unused.git", ref: "main", port: 0, revision: "r1" };
    const created = await host.driver.ops["app.create"]!({ desired }, call("testhost.app.create"));
    url = (created as { state: { url: string } }).state.url;
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    wakeup.close();
    await client?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The run of the schedule's first tick after `after`, once it finished, and the time it was for. */
  const tickAfter = async (after: Date) => {
    for (const run of await client.runs({ workflow: "wakeup-check-tick", limit: 10 })) {
      const records = await client.ledger(run.runId);
      const [started] = records;
      const at = started?.type === "run.started" ? started.scheduledFor : undefined;
      if (at && Date.parse(at) > after.getTime() && records.some((r) => r.type === "run.finished"))
        return { runId: run.runId, at: new Date(at) };
    }
    return undefined;
  };

  it(
    "stops the worker idle and the process, and the wakes continue the sleep and run the tick",
    { timeout: 240_000 },
    async () => {
      const begun = new Date();
      // Asleep first, so the worker has a deadline once apply has made the wakeup.
      const sleeping = await client.start("host-check-sleep", { seconds: 5 }, { startedBy: { id: "stack" } });
      await waitFor(async () => (await client.ledger(sleeping)).some((r) => r.type === "sleep.started"));

      // Apply gives the wakeup the URL its host's state names.
      const runId = await client.apply({ only: [`${INFRA}#wake`] }, { startedBy: { id: "stack" } });
      expect((await client.applyReport(runId)).results).toEqual([
        { id: `${INFRA}#wake`, action: "create", status: "done", binding: "wake" },
      ]);
      const timer = await wakeup.driver.ops["timer.read"]!({ id: "wake" }, call("testwakeup.timer.read"));
      expect(timer).toMatchObject({ state: { name: "wake", host: url } });

      // The worker stops itself with its next deadline registered; then the process stops, as a
      // host that stops on exit stops it once the app is quiet.
      const registered = await waitFor(
        async () => {
          const last = wakeup.registered().at(-1);
          return last && (await shouldWake(databaseUrl, last.generation)) ? last : undefined;
        },
        Boolean,
        30_000,
      );
      await host.stop();
      const stopped = new Date();

      // The wake starts the process; the sleep ends; the worker stops again; a wake starts a fresh
      // one in the process; the tick that fell while it was stopped runs. In either order.
      expect(await client.result(sleeping, 120_000)).toEqual({ slept: 5 });
      const tick = (await waitFor(() => tickAfter(begun), Boolean, 150_000))!;
      expect((await client.ledger(sleeping)).map((r) => r.type)).toEqual(
        expect.arrayContaining(["sleep.started", "run.finished"]),
      );

      const wakes = host.wakes();
      // The wake for the deadline the worker stopped with came after the process stopped, and started it.
      expect(wakes.find((w) => w.generation === registered!.generation)?.at.getTime()).toBeGreaterThanOrEqual(
        stopped.getTime(),
      );
      // One came at the tick's time, or after, and the tick ran on a worker it started.
      expect(wakes.some((w) => w.at >= tick.at)).toBe(true);
      expect(wakes.length).toBeGreaterThanOrEqual(2);
      expect(wakeup.registered().length).toBeGreaterThanOrEqual(2);
    },
  );
});
