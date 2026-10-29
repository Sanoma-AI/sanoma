import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { fakeHost, hostCheck, inProcessHost } from "@sanoma-ai/testing/host";
import { live, replay } from "@sanoma-ai/testing/replay";
import { checkWakeup, wakeupCheckWorkflows } from "@sanoma-ai/testing/wakeup";
import { delay, http, HttpResponse } from "msw";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerWakeup } from "../src/deadlines.ts";
import { describeConfig } from "../src/describe.ts";
import {
  type CallContext,
  declaredWakeup,
  type Driver,
  DriverError,
  memoryLedger,
  memorySecrets,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Secrets,
} from "../src/index.ts";
import { fakeSanomaWakeup } from "../src/fake.ts";
import { sanomaWakeupDriver } from "../src/wakeup-driver.ts";
import { mintInstanceToken, startWakeupService } from "../src/wakeup-service.ts";
import { wakeup } from "../src/wakeup-type.ts";
import { rootWith } from "./harness.ts";
import { replayOptions, TEST_ACCOUNT_TOKEN } from "./wakeup-replay.ts";

// `sanoma.wakeup`, the runtime's own wakeup over a wakeup service: its driver over the service's
// recorded replies (test/fixtures/wakeup, recorded against a local `sanoma wakeup`: SANOMA_LIVE=1
// SANOMA_RECORD=1 with SANOMA_WAKEUP_URL and SANOMA_WAKEUP_ACCOUNT_TOKEN set records them), the
// Wakeup contract's kit against the fake and the real service (needs Postgres: `pnpm db:up`), and
// its place in every config with a host type. Its features are `wakeup-features.test.ts`'s.

/** The real wakeup service in this process, on its own database, served over srvx on a free port, as `sanoma wakeup` serves it. */
async function serveWakeup(databaseUrl: string) {
  const service = await startWakeupService({ databaseUrl, log: { info: () => {}, warn: () => {} } });
  const [route] = service.routes;
  const server = createServer((req, res) => {
    void route!.handle(new NodeRequest({ req, res })).then((answer) => sendNodeResponse(res, answer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mintAccount: service.mintAccount,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await service.stop();
    },
  };
}

let n = 0;
const callWith = (secrets: Secrets = memorySecrets()): CallContext => ({
  idempotencyKey: `run-1:${++n}`,
  runId: "run-1",
  opId: "sanoma.wakeup",
  attempt: 1,
  secrets: {
    get: async (name) =>
      ["SANOMA_WAKEUP_URL", "SANOMA_WAKEUP_ACCOUNT_TOKEN"].includes(name) ? process.env[name] : secrets.get(name),
    ensure: (name, make) => secrets.ensure(name, make),
  },
});

const op = (name: string, input: object, call = callWith(), driver = sanomaWakeupDriver()) =>
  driver.ops[`wakeup.${name}`]!(input, call);
/** The `DriverError` `promise` fails with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable(),
    (err: DriverError) => err,
  );

describe.skipIf(live)("sanomaWakeupDriver", () => {
  const { server, play, sent } = replay(replayOptions);
  const ID = "00000000-0000-4000-8000-000000000001";
  const HOST = "https://company.example.test";
  /** An instance as `GET /wakeup/instances/{id}` shows it. */
  const shown = { id: ID, url: HOST, at: null, calledAt: null, attempts: 0, lastError: null };

  it("creates an instance with the account's token and the stored instance token, which it never returns", async () => {
    play("create");
    // A new one per test, as /setup mints one, so a live recording makes a new instance for each.
    const token = mintInstanceToken();
    const made = await op(
      "create",
      { desired: { host: `${HOST}/` } },
      callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: token })),
    );
    expect(made).toEqual({ id: ID, state: { id: ID, host: HOST, at: null, lastError: null } });
    expect(JSON.stringify(made)).not.toContain("swi_");
    expect(sent[0]).toMatchObject({ method: "POST", path: "/wakeup/instances", body: { url: HOST, token } });
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_ACCOUNT_TOKEN}`);
  });

  it("mints and stores an instance token when none is, for a data file written without /setup", async () => {
    play("mint", [{ method: "POST", path: "/wakeup/instances", status: 201, body: { id: ID } }]);
    const secrets = memorySecrets();
    await op("create", { desired: { host: HOST } }, callWith(secrets));
    const token = await secrets.get("SANOMA_WAKEUP_TOKEN");
    expect(token).toMatch(/^swi_[\w-]{43}$/);
    expect(sent[0]).toMatchObject({ body: { url: HOST, token } });
  });

  it("refuses another account's instance token with the way out: a new one from /setup", async () => {
    const error = "the token is another account's instance's";
    play("taken", [{ method: "POST", path: "/wakeup/instances", status: 409, body: { error } }]);
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: mintInstanceToken() }));
    expect(await failure(op("create", { desired: { host: HOST } }, call))).toMatchObject({
      status: 409,
      retryable: false,
      message: expect.stringMatching(new RegExp(`${error}: a new account needs a new instance token .*/setup`)),
    });
  });

  it("registers a wake with the instance's own token", async () => {
    play("register");
    const token = mintInstanceToken();
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: token }));
    const { id } = (await op("create", { desired: { host: HOST } }, call)) as { id: string };
    await op("register", { at: "2099-01-01T00:00:00Z" }, call);
    expect(sent[1]).toMatchObject({ method: "PUT", path: "/wakeup/wake", body: { at: "2099-01-01T00:00:00Z" } });
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await op("read", { id }, call)).toMatchObject({ state: { at: "2099-01-01T00:00:00.000Z" } });
  });

  it("plans no change for the same host written another way, as the service keeps URLs", async () => {
    play("same-host", [{ method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown }]);
    const plan = await op("plan", { id: ID, desired: { host: "https://COMPANY.example.test:443/" } });
    expect(plan).toMatchObject({ action: "none", replace: [] });
  });

  it("moves the instance to a new host by posting its token again: an update, never a replace", async () => {
    play("new-host", [
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown },
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 200, body: shown },
      { method: "POST", path: "/wakeup/instances", status: 200, body: { id: ID } },
    ]);
    const desired = { host: "https://elsewhere.example.test" };
    const plan = await op("plan", { id: ID, desired });
    expect(plan).toMatchObject({
      action: "update",
      replace: [],
      planned: { host: desired.host, at: null, lastError: null },
    });
    const token = mintInstanceToken();
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: token }));
    const moved = await op("update", { id: ID, desired, expect: { action: "update", replace: [] } }, call);
    expect(moved).toMatchObject({ id: ID, state: { host: desired.host } });
    expect(sent[2]).toMatchObject({ method: "POST", body: { url: desired.host, token } });
  });

  it("reads a 404 that is not the service's as a failure, not as gone", async () => {
    play("not-the-service", [
      { method: "GET", path: `/wakeup/instances/${ID}`, status: 404, body: "<html>Not found</html>" },
    ]);
    expect(await failure(op("read", { id: ID }))).toMatchObject({ status: 404, retryable: false });
  });

  it("reads an instance the service does not have as gone, and deletes it as done", async () => {
    const missing = { status: 404, body: { error: "no such instance" } };
    play("gone", [
      { method: "GET", path: `/wakeup/instances/${ID}`, ...missing },
      { method: "DELETE", path: `/wakeup/instances/${ID}`, ...missing },
    ]);
    expect(await op("read", { id: ID })).toEqual({ id: ID, gone: true });
    expect(await op("delete", { id: ID })).toEqual({ id: ID, gone: true });
  });

  it("refuses without its URL or tokens, before any request", async () => {
    vi.stubEnv("SANOMA_WAKEUP_ACCOUNT_TOKEN", "");
    await expect(op("read", { id: ID })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_WAKEUP_ACCOUNT_TOKEN is not set"),
    });
    await expect(op("register", { at: "2099-01-01T00:00:00Z" })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_WAKEUP_TOKEN is not set: connect a wakeup service in /setup"),
    });
    vi.stubEnv("SANOMA_WAKEUP_URL", "");
    const call = callWith(memorySecrets({ SANOMA_WAKEUP_TOKEN: mintInstanceToken() }));
    await expect(op("register", { at: "2099-01-01T00:00:00Z" }, call)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("SANOMA_WAKEUP_URL is not set"),
    });
    expect(sent).toEqual([]);
  });

  it.each([
    [401, false],
    [403, false],
    [400, false],
    [408, true],
    [429, true],
    [503, true],
  ])("maps a %i to a DriverError, retryable %s, keeping its status", async (status, retryable) => {
    play("status", [{ method: "GET", path: `/wakeup/instances/${ID}`, status, body: { error: "said the service" } }]);
    const err = await failure(op("read", { id: ID }));
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({
      status,
      retryable,
      message: `sanoma.wakeup: GET /wakeup/instances/${ID}: said the service`,
    });
  });

  it("retries no reply and a timeout", async () => {
    server.use(http.all("*", () => HttpResponse.error()));
    expect(await failure(op("read", { id: ID }))).toMatchObject({ retryable: true });
    server.use(http.all("*", () => delay("infinite")));
    const slow = op("read", { id: ID }, callWith(), sanomaWakeupDriver({ timeoutMs: 50 }));
    expect(await failure(slow)).toMatchObject({
      retryable: true,
      message: expect.stringContaining("no reply in 50 ms"),
    });
  });
});

const ALL_PASS = [
  { name: "a registered wake arrives after `at`", ok: true },
  { name: "a wake registered before a stop drains a queued run after it", ok: true },
  { name: "a registration replaced before `at` never wakes the host", ok: true },
  { name: "a wake at a schedule's next fire, while the host is stopped, runs that tick", ok: true },
];

describe("sanoma.wakeup meets the Wakeup contract", () => {
  const root = mkdtempSync(join(tmpdir(), "sanoma-wakeup-"));
  // An app of its own per run: DBOS fires every tick of the kit's schedule an app missed.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: `sanoma-wakeup-${Date.now()}` }));
  const databaseUrl = testDatabaseUrl("sanoma_wakeup_host");
  const config: SanomaConfig = {
    workflows: [...wakeupCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const host = fakeHost(inProcessHost(config, databaseUrl), { lifetime: "stops-when-quiet" });
  config.connectors.push(host.connector);
  let client: SanomaClient;
  let url: string;

  beforeAll(async () => {
    const desired = { name: "company", source: "file:///unused.git", ref: "main", port: 0, revision: "r1" };
    const call = callWith(memorySecrets());
    url = ((await host.driver.ops["app.create"]!({ desired }, call)) as { state: { url: string } }).state.url;
    client = await SanomaClient.connect(config);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Creates an instance for the host through `driver` with a token minted as /setup mints it,
   * then runs the kit, registering through it. `env` is set before each call: the host's own
   * worker owns `sanoma.wakeup`'s variables in this process, loading them from its database and
   * clearing them as it stops.
   */
  const conform = async (driver: Driver, env: Record<string, string> = {}) => {
    // One instance token; a call of its own each, as a fake answers a repeated key from memory.
    const secrets = memorySecrets({ SANOMA_WAKEUP_TOKEN: mintInstanceToken() });
    const call = (name: string, input: object) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      return op(name, input, callWith(secrets), driver);
    };
    const { id } = (await call("create", { desired: { host: url } })) as { id: string };
    const results = await checkWakeup({
      type: wakeup,
      host: { url, stop: () => host.stop(), wakes: () => host.wakes() },
      client,
      register: async (registration) => void (await call("register", registration)),
      timeoutMs: 30_000,
    });
    await call("delete", { id });
    return results;
  };

  it("passes every check against the fake", { timeout: 300_000 }, async () => {
    const fake = fakeSanomaWakeup();
    try {
      expect(await conform(fake.driver)).toEqual(ALL_PASS);
    } finally {
      fake.close();
    }
  });

  it("passes every check against the real wakeup service", { timeout: 300_000 }, async () => {
    const service = await serveWakeup(testDatabaseUrl("sanoma_wakeup_service"));
    try {
      const env = {
        SANOMA_WAKEUP_URL: service.url,
        SANOMA_WAKEUP_ACCOUNT_TOKEN: (await service.mintAccount("conformance")).token,
      };
      expect(await conform(sanomaWakeupDriver(), env)).toEqual(ALL_PASS);
    } finally {
      vi.unstubAllEnvs();
      await service.stop();
    }
  });
});

const withHost = () => [fakeHost(async () => ({ url: "", stop: async () => undefined })).connector];

describe("the built-in wakeup's fake under the stop rule's registrations", () => {
  it("re-arms an earlier `at` registered again after another: register X, then Y, then X, and X fires", async () => {
    let wakes = 0;
    const server = createServer((req, res) => {
      if (req.url === "/wake") wakes++;
      res.writeHead(204).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fake = fakeSanomaWakeup();
    try {
      const secrets = memorySecrets({ SANOMA_WAKEUP_TOKEN: mintInstanceToken() });
      await op("create", { desired: { host: url } }, callWith(secrets), fake.driver);
      const resolved = resolveConfig({ workflows: [], connectors: withHost(), ledger: memoryLedger() });
      const rule = {
        register: { op: resolved.ops.get("sanoma.wakeup.register")!, fn: fake.driver.ops["wakeup.register"] },
        secrets,
        wakeup: "resources/infra.ts#wakeup",
      };
      const x = new Date(Date.now() + 300).toISOString();
      const y = new Date(Date.now() + 3_600_000).toISOString();
      for (const at of [x, y, x]) await registerWakeup(rule, { at });
      await vi.waitFor(() => expect(wakes).toBe(1), { timeout: 10_000 });
    } finally {
      fake.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("sanoma.wakeup in a config", () => {
  it("is every config's with a host type, no connector named, and no config's without one", () => {
    const resolved = resolveConfig({ workflows: [], connectors: withHost(), ledger: memoryLedger() });
    expect(resolved.types.get("sanoma.wakeup")).toBe(wakeup);
    expect(resolved.ops.has("sanoma.wakeup.register")).toBe(true);
    expect(resolved.driversByVendor.has("sanoma")).toBe(true);
    expect(resolved.fakes.has("sanoma")).toBe(true);
    const bare = resolveConfig({ workflows: [], connectors: [], ledger: memoryLedger() });
    expect(bare.types.has("sanoma.wakeup")).toBe(false);
    expect(bare.driversByVendor.has("sanoma")).toBe(false);
  });

  it("declares the wakeup for the host it names, which the config reads as its one wakeup, and admits as before", async () => {
    const root = rootWith({
      "resources/infra.ts": [
        'import { sanoma } from "sanoma/resources";',
        'import { testhost } from "@sanoma-ai/testing-host/resources";',
        "",
        'export const app = testhost.app({ name: "company", source: "file:///unused.git", ref: "main", port: 0 });',
        "export const wakeup = sanoma.wakeup({ host: app });",
        "",
      ].join("\n"),
    });
    const config: SanomaConfig = {
      workflows: [],
      connectors: withHost(),
      root,
      databaseUrl: testDatabaseUrl("sanoma_wakeup_declared"),
    };
    try {
      const described = describeConfig(config);
      expect(described.problems).toEqual([]);
      expect(described.resourceTypes.map((t) => t.id)).toContain("sanoma.wakeup");
      expect(await declaredWakeup(config)).toMatchObject({
        id: "resources/infra.ts#wakeup",
        declared: { vendor: "sanoma", type: "wakeup", desired: { host: "company" } },
      });
      // Read with the people, and left out of them: nobody is declared, so anyone is admitted.
      const { readPeople } = await import("../src/resources.ts");
      expect(readPeople(root)).toEqual({ people: [], problems: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
