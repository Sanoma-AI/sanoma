import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { fakeHost, hostCheck, hostCheckWorkflows, inProcessHost } from "@sanoma-ai/testing/host";
import { checkWakeup } from "@sanoma-ai/testing/wakeup";
import {
  type CallContext,
  declaredWakeup,
  type Driver,
  memoryLedger,
  memorySecrets,
  SanomaClient,
  type SanomaConfig,
  type Secrets,
} from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wakeup } from "../src/connector.ts";
import { sanomaOpsDriver } from "../src/driver.ts";
import { fakeSanomaOps } from "../src/fake.ts";
import { sanomaOps } from "../src/index.ts";
import { serveWakeup } from "./service.ts";

// Needs Postgres: `pnpm db:up`. The Wakeup contract's conformance kit against the fake and
// against the real wakeup service (`sanoma wakeup`'s), served in this process on a database of
// its own, each waking a host in this process behind the proxy of a host that stops.

const ALL_PASS = [
  { name: "a registered wake arrives after `at`", ok: true },
  { name: "a wake registered before a stop drains a queued run after it", ok: true },
  { name: "a replaced generation runs nothing", ok: true },
];

let n = 0;
const callWith =
  (secrets: Secrets) =>
  (opId: string): CallContext => ({
    idempotencyKey: `${opId}:${++n}`,
    runId: "conformance",
    opId,
    attempt: 1,
    secrets,
  });

describe("sanomaOps.wakeup meets the Wakeup contract", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-ops-wakeup-"));
  const databaseUrl = testDatabaseUrl("sanoma_ops_host");
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const host = fakeHost(inProcessHost(config, databaseUrl), { lifetime: "stops-on-exit" });
  config.connectors.push(host.connector);
  let client: SanomaClient;
  let url: string;

  beforeAll(async () => {
    const desired = { name: "company", source: "file:///unused.git", ref: "main", port: 0, revision: "r1" };
    const call = callWith(memorySecrets())("testhost.app.create");
    url = ((await host.driver.ops["app.create"]!({ desired }, call)) as { state: { url: string } }).state.url;
    client = await SanomaClient.connect(config);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Creates an instance for the host through `driver`, then runs the kit, registering through it. */
  const conform = async (driver: Driver) => {
    const call = callWith(memorySecrets());
    const op = (name: string) => (input: object) =>
      driver.ops[`wakeup.${name}`]!(input, call(`sanomaOps.wakeup.${name}`));
    const { id } = (await op("create")({ desired: { host: url } })) as { id: string };
    const results = await checkWakeup({
      type: wakeup,
      host: { url, stop: () => host.stop(), wakes: () => host.wakes() },
      client,
      register: async (registration) => void (await op("register")(registration)),
      timeoutMs: 30_000,
    });
    await op("delete")({ id });
    return results;
  };

  it("passes every check against the fake", { timeout: 180_000 }, async () => {
    const fake = fakeSanomaOps();
    try {
      expect(await conform(fake.driver)).toEqual(ALL_PASS);
    } finally {
      fake.close();
    }
  });

  it("passes every check against the real wakeup service", { timeout: 180_000 }, async () => {
    const service = await serveWakeup(testDatabaseUrl("sanoma_ops_service"));
    const saved = { url: process.env.SANOMA_OPS_URL, token: process.env.SANOMA_OPS_TOKEN };
    try {
      process.env.SANOMA_OPS_URL = service.url;
      process.env.SANOMA_OPS_TOKEN = (await service.mintAccount("conformance")).token;
      expect(await conform(sanomaOpsDriver())).toEqual(ALL_PASS);
    } finally {
      for (const [name, value] of [
        ["SANOMA_OPS_URL", saved.url],
        ["SANOMA_OPS_TOKEN", saved.token],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await service.stop();
    }
  });
});

describe("sanomaOps.wakeup in a data file", () => {
  it("declares the wakeup for the host it names, which the config reads as its one wakeup", async () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-ops-declared-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "infra.ts"),
      [
        'import { sanomaOps } from "@sanoma-ai/connector-sanoma-ops/resources";',
        'import { testhost } from "@sanoma-ai/testing-host/resources";',
        "",
        'export const app = testhost.app({ name: "company", source: "file:///unused.git", ref: "main", port: 0 });',
        "export const wakeup = sanomaOps.wakeup({ host: app });",
        "",
      ].join("\n"),
    );
    const config: SanomaConfig = {
      workflows: [],
      connectors: [fakeHost(async () => ({ url: "", stop: async () => undefined })).connector, sanomaOps],
      root,
      databaseUrl: testDatabaseUrl("sanoma_ops_declared"),
    };
    try {
      expect(describeConfig(config).problems).toEqual([]);
      expect(await declaredWakeup(config)).toMatchObject({
        id: "resources/infra.ts#wakeup",
        declared: { vendor: "sanomaOps", type: "wakeup", desired: { host: "company" } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
