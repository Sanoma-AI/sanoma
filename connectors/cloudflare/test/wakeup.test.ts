import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { hostCheck, inProcessHost } from "@sanoma-ai/testing/host";
import { checkWakeup, wakeupCheckWorkflows } from "@sanoma-ai/testing/wakeup";
import {
  type CallContext,
  declaredWakeup,
  memoryLedger,
  memorySecrets,
  SanomaClient,
  type SanomaConfig,
  type Secrets,
} from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { mintInstanceToken } from "@sanoma-ai/workflows/wakeup-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alarm } from "../src/connector.ts";
import { fakeCloudflare } from "../src/fake.ts";
import { cloudflare } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. The Wakeup contract's conformance kit against `cloudflare.alarm`
// on the fake: the alarm of the host's own object, which rings on a timer in this process, starts
// the container the fake stopped, and calls its `/wake`.

const ALL_PASS = [
  { name: "a registered wake arrives after `at`", ok: true },
  { name: "a wake registered before a stop drains a queued run after it", ok: true },
  { name: "a registration replaced before `at` never wakes the host", ok: true },
  { name: "a wake at a schedule's next fire, while the host is stopped, runs that tick", ok: true },
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

describe("cloudflare.alarm meets the Wakeup contract on the fake", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-wakeup-"));
  // An app of its own per run: DBOS fires every tick of the kit's schedule an app missed.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: `cloudflare-wakeup-${Date.now()}` }));
  const databaseUrl = testDatabaseUrl("cloudflare_wakeup");
  const config: SanomaConfig = {
    workflows: [...wakeupCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const fake = fakeCloudflare({
    start: ({ revision, env }) => inProcessHost(config, databaseUrl)({ port: 0, revision, secrets: env }),
  });
  // As /setup mints it: the host's secrets name it, and the alarm's operations send it.
  const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: mintInstanceToken() }));
  const op = (name: string) => (input: object) => fake.driver.ops[name]!(input, call(`cloudflare.${name}`));
  let client: SanomaClient;
  let url: string;

  beforeAll(async () => {
    const desired = {
      name: "company",
      image: "docker.io/sanomaai/runtime:0.7.0",
      source: "file:///unused.git",
      ref: "main",
      port: 3000,
      revision: "r1",
      secrets: { SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN") },
    };
    url = ((await op("container.create")({ desired })) as { state: { url: string } }).state.url;
    client = await SanomaClient.connect(config);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes every check", { timeout: 300_000 }, async () => {
    const made = (await op("alarm.create")({ desired: { host: url } })) as { id: string };
    expect(made).toMatchObject({ id: url, state: { host: url, at: null, rang: null, healthy: true } });
    const results = await checkWakeup({
      type: alarm,
      host: { url, stop: () => fake.stop("company"), wakes: () => fake.wakes() },
      client,
      register: async (registration) => void (await op("alarm.register")(registration)),
      timeoutMs: 30_000,
    });
    expect(results).toEqual(ALL_PASS);
    expect(await op("alarm.read")({ id: url })).toMatchObject({ state: { at: expect.any(String), healthy: true } });
    await op("alarm.delete")({ id: url });
    expect(await op("alarm.read")({ id: url })).toMatchObject({ state: { at: null } });
  });
});

describe("cloudflare.alarm in a data file", () => {
  it("declares the wakeup for the container it names, which the config reads as its one wakeup", async () => {
    const root = mkdtempSync(join(tmpdir(), "cloudflare-declared-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "infra.ts"),
      [
        'import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";',
        'import { secret } from "@sanoma-ai/workflows/resources";',
        "",
        "export const host = cloudflare.container({",
        '  name: "company",',
        '  image: "docker.io/sanomaai/runtime:0.7.0",',
        '  source: "https://github.com/acme/company.git",',
        '  ref: "main",',
        "  port: 3000,",
        '  secrets: { SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN", { generate: true }) },',
        "});",
        "export const wakeup = cloudflare.alarm({ host });",
        "",
      ].join("\n"),
    );
    const config: SanomaConfig = {
      workflows: [],
      connectors: [cloudflare],
      root,
      databaseUrl: testDatabaseUrl("cloudflare_declared"),
    };
    try {
      expect(describeConfig(config).problems).toEqual([]);
      expect(await declaredWakeup(config)).toMatchObject({
        id: "resources/infra.ts#wakeup",
        declared: { vendor: "cloudflare", type: "alarm", desired: { host: "company" } },
        host: { id: "resources/infra.ts#host" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
