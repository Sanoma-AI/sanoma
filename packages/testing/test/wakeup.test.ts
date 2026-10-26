import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallContext,
  declaredWakeup,
  memoryLedger,
  memorySecrets,
  SanomaClient,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl, waitFor } from "../src/index.ts";
import { fakeHost, hostCheck, hostCheckWorkflows, inProcessHost } from "../src/host.ts";
import { checkWakeup, fakeWakeup, fakeWakeupType } from "../src/wakeup.ts";

// Needs Postgres: `pnpm db:up`. The wakeup kit against the fake wakeup, waking a host in this
// process behind the proxy of a host that stops: its runtime stops, and the wake starts it.
const databaseUrl = testDatabaseUrl("wakeup_kit");

const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${Date.now()}`,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets({}),
});

describe("the wakeup conformance kit", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-wakeup-kit-"));
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  // `failNext` fails the runtime's next start, as a host that is not up yet.
  let failNext = false;
  const start = inProcessHost(config, databaseUrl);
  const host = fakeHost(
    async (input) => {
      if (!failNext) return start(input);
      failNext = false;
      throw new Error("not up yet");
    },
    { lifetime: "stops-on-exit" },
  );
  const wakeup = fakeWakeup();
  config.connectors.push(host.connector, wakeup.connector);
  const timer = (name: string) => (input: object) =>
    wakeup.driver.ops[`timer.${name}`]!(input, call(`testwakeup.timer.${name}`));
  let client: SanomaClient;
  let url: string;

  beforeAll(async () => {
    const desired = { name: "company", source: "file:///unused.git", ref: "main", port: 0, revision: "r1" };
    const created = await host.driver.ops["app.create"]!({ desired }, call("testhost.app.create"));
    url = (created as { state: { url: string } }).state.url;
    await timer("create")({ desired: { name: "wake", host: url } });
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    wakeup.close();
    await client?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes every check against the fake wakeup and a host that stops", { timeout: 180_000 }, async () => {
    const results = await checkWakeup({
      type: fakeWakeupType,
      host: { url, stop: () => host.stop(), wakes: () => host.wakes() },
      client,
      register: async (registration) => void (await timer("register")(registration)),
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "a registered wake arrives after `at`", ok: true },
      { name: "a wake registered before a stop drains a queued run after it", ok: true },
      { name: "a replaced generation runs nothing", ok: true },
    ]);
  });

  it("fires the armed wake now, whatever its at", async () => {
    const before = host.wakes().length;
    await timer("register")({ at: new Date(Date.now() + 3_600_000).toISOString(), generation: 9 });
    await wakeup.fire();
    expect(
      host
        .wakes()
        .slice(before)
        .map((w) => w.generation),
    ).toEqual([9]);
  });

  it("sends a wake again until the host answers it", async () => {
    await host.stop();
    const before = host.wakes().length;
    // The runtime's next start fails once: the first wake gets a 502 from the proxy.
    failNext = true;
    await timer("register")({ at: new Date().toISOString(), generation: 10 });
    await waitFor(
      () => host.wakes().slice(before),
      (wakes) => wakes.some((w) => w.generation === 10),
      30_000,
    );
    expect(failNext).toBe(false);
  });
});

describe("fakeWakeup", () => {
  it("refuses to register before apply created its timer", async () => {
    const wakeup = fakeWakeup();
    await expect(
      wakeup.driver.ops["timer.register"]!(
        { at: new Date().toISOString(), generation: 1 },
        call("testwakeup.timer.register"),
      ),
    ).rejects.toThrow("testwakeup: register wakes the one timer apply created, not 0");
  });

  it("meets the Wakeup contract: a data file declares it for a host it names", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-wakeup-contract-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "infra.ts"),
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
      workflows: [],
      connectors: [fakeHost(async () => ({ url: "", stop: async () => undefined })).connector, fakeWakeup().connector],
      root,
      databaseUrl,
    };
    expect(describeConfig(config).problems).toEqual([]);
    expect(await declaredWakeup(config)).toMatchObject({
      id: "resources/infra.ts#wake",
      declared: { vendor: "testwakeup", type: "timer", desired: { name: "wake", host: "company" } },
    });
    rmSync(root, { recursive: true, force: true });
  });
});
