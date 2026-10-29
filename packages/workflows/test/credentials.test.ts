import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import {
  checkSecretStore,
  defineConnector,
  defineDriver,
  defineWorkflow,
  memoryLedger,
  memorySecretStore,
  SanomaClient,
  SecretAccess,
  startWorker,
  withSetup,
} from "../src/index.ts";
import { configuredSecrets, postgresSecretStore } from "../src/credentials.ts";
import { lazyPool } from "../src/db.ts";
import { credentialsOf } from "../src/env.ts";

const databaseUrl = testDatabaseUrl("credentials_v2");
const pool = lazyPool(databaseUrl, "secret-tests");
const store = postgresSecretStore(() => pool.db());
afterAll(() => pool.close());
afterEach(() => vi.unstubAllEnvs());

const acmeOps = defineConnector("acme", {
  thing: {
    get: {
      effect: "read",
      input: z.object({}),
      output: z.object({ configured: z.boolean() }),
    },
  },
});
const acme = withSetup(acmeOps, {
  driver: () =>
    defineDriver(acmeOps, {
      thing: {
        get: async (_input, call) => ({ configured: (await call.secrets.get("API_KEY")) === "stored-key" }),
      },
    }),
});
const workflow = defineWorkflow({
  name: "credential-probe",
  trigger: "manual",
  input: z.object({}),
  uses: [acme.thing.get],
  run: async (ctx) => ctx.acme.thing.get({}),
});

beforeAll(async () => {
  await pool.db();
});

describe("encrypted Postgres store", () => {
  it("passes shared conformance against actual Postgres", async () => {
    const checks = await checkSecretStore(store, randomUUID());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(6);
  });
  it("coordinates separate clients and rejects stale mutations", async () => {
    const namespace = randomUUID();
    const db2 = new Client({ connectionString: databaseUrl });
    await db2.connect();
    try {
      const a = new SecretAccess({ namespace }, store);
      const b = new SecretAccess(
        { namespace },
        postgresSecretStore(async () => db2),
      );
      const values = await Promise.all([a.ensure("TOKEN", () => "first"), b.ensure("TOKEN", () => "second")]);
      expect(values[0]).toBe(values[1]);
      const version = (await a.read("TOKEN"))!.version;
      await b.write("TOKEN", "replaced", { expectedVersion: version, by: "other" });
      await expect(a.delete("TOKEN", { expectedVersion: version, by: "test" })).rejects.toMatchObject({
        code: "conflict",
      });
    } finally {
      await db2.end();
    }
  });
  it("authenticates namespace/path and rejects plaintext rows", async () => {
    const namespace = randomUUID();
    const a = new SecretAccess({ namespace }, store);
    await a.ensure("TOKEN", () => "never-plaintext");
    const db = await pool.db();
    const row = (
      await db.query("SELECT value FROM sanoma_credentials WHERE namespace=$1 AND name=$2", [namespace, "TOKEN"])
    ).rows[0];
    expect(row.value).not.toContain("never-plaintext");
    await db.query("UPDATE sanoma_credentials SET name=$2 WHERE namespace=$1", [namespace, "MOVED"]);
    await expect(a.get("MOVED")).rejects.toMatchObject({ code: "invalid_value" });
    await db.query("UPDATE sanoma_credentials SET value=$2 WHERE namespace=$1", [namespace, "never-plaintext"]);
    await expect(a.get("MOVED")).rejects.toMatchObject({ code: "invalid_value" });
  });
  it("does not override values from the selected store with process environment", async () => {
    const namespace = randomUUID();
    const a = configuredSecrets({ namespace }, () => pool.db());
    vi.stubEnv("API_KEY", "from-environment");
    expect(await a.get("API_KEY")).toBeUndefined();
    await a.ensure("API_KEY", () => "from-store");
    expect(await a.get("API_KEY")).toBe("from-store");
  });
});

describe("runtime uses the selected store", () => {
  it("client mutations, direct calls and durable worker calls share the provider without loading process.env", async () => {
    const custom = memorySecretStore();
    const ledger = memoryLedger();
    const config = {
      connectors: [acme],
      workflows: [workflow],
      databaseUrl,
      ledger,
      secrets: { store: custom, namespace: randomUUID() },
    };
    const client = await SanomaClient.connect(config);
    vi.stubEnv("API_KEY", "unrelated-environment");
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await client.setSecret("API_KEY", "stored-key", { by: "tester" });
      expect(await client.call("acme.thing.get", {}, { actor: { id: "tester" } })).toEqual({ configured: true });
      worker = await startWorker(config);
      const run = await client.start(workflow, {}, { startedBy: { id: "tester" } });
      expect(await client.result(run, 10_000)).toEqual({ configured: true });
      expect(process.env.API_KEY).toBe("unrelated-environment");
      expect((await client.secrets(["API_KEY"])).get("API_KEY")).toMatchObject({
        value: "stored-key",
        location: { store: "memory" },
      });
      const db = await pool.db();
      expect(
        (await db.query("SELECT name FROM sanoma_credentials WHERE namespace=$1", [config.secrets.namespace])).rows,
      ).toEqual([]);
      expect(JSON.stringify(await client.ledger(run))).not.toContain("stored-key");
      await client.clearSecret("API_KEY", { by: "tester" });
      expect((await client.secrets(["API_KEY"])).size).toBe(0);
      expect(await client.call("acme.thing.get", {}, { actor: { id: "tester" } })).toEqual({ configured: false });
      await client.clearSecret("API_KEY", { by: "tester" });
      await expect(client.clearSecret("invalid/path", { by: "tester" })).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      await worker?.stop();
      await client.close();
    }
  });
  it("external stores do not need a row encryption key, and denied providers fail sanitized", async () => {
    vi.stubEnv("SANOMA_SECRETS_KEY", undefined);
    const custom = memorySecretStore();
    const client = await SanomaClient.connect({ connectors: [], databaseUrl, secrets: { store: custom } });
    try {
      await client.setSecret("VALUE", "value", { by: "tester" });
    } finally {
      await client.close();
    }
    await expect(
      SanomaClient.connect({
        connectors: [],
        databaseUrl,
        secrets: {
          store: {
            ...custom,
            validate: async () => {
              throw new Error("provider-value-must-not-leak");
            },
          },
        },
      }),
    ).rejects.toMatchObject({ message: "Secret store: unavailable" });
  });
  it("external bindings reject client mutations and expose only location/status through credentials", async () => {
    const custom = memorySecretStore();
    await custom.write({ namespace: "default", path: "existing/key" }, "secret-value", {
      expectedVersion: null,
      by: "owner",
    });
    const declared = withSetup(acmeOps, {
      driver: () =>
        defineDriver(
          acmeOps,
          { thing: { get: async () => ({ configured: true }) } },
          { env: z.object({ API_KEY: z.string() }) },
        ),
    });
    const client = await SanomaClient.connect({
      connectors: [declared],
      databaseUrl,
      secrets: { store: custom, bindings: { API_KEY: { path: "existing/key", management: "external" } } },
    });
    try {
      await expect(client.setCredential("API_KEY", "replace", { by: "tester" })).rejects.toMatchObject({
        code: "read_only",
      });
      await expect(client.clearCredential("API_KEY", { by: "tester" })).rejects.toMatchObject({ code: "read_only" });
      await expect(client.clearSecret("API_KEY", { by: "tester" })).rejects.toMatchObject({ code: "read_only" });
      const statuses = await client.credentials();
      expect(statuses.get("acme")?.[0]).toMatchObject({
        status: "set",
        location: { management: "external", path: "existing/key" },
      });
      expect(JSON.stringify([...statuses])).not.toContain("secret-value");
    } finally {
      await client.close();
    }
  });
  it("schema messages cannot reveal supplied values", () => {
    const driver = defineDriver(
      acmeOps,
      { thing: { get: async () => ({ configured: true }) } },
      {
        env: z.object({
          TOKEN: z.string().superRefine((value, ctx) => ctx.addIssue({ code: "custom", message: value })),
        }),
      },
    );
    expect(JSON.stringify([...credentialsOf(new Map([["acme", driver]]), () => "sensitive")])).not.toContain(
      "sensitive",
    );
  });
  it("schema exceptions cannot reveal supplied values", () => {
    const driver = defineDriver(
      acmeOps,
      { thing: { get: async () => ({ configured: true }) } },
      {
        env: z.object({
          TOKEN: z.string().refine(() => {
            throw new Error("sensitive");
          }),
        }),
      },
    );
    expect(JSON.stringify([...credentialsOf(new Map([["acme", driver]]), () => "sensitive")])).not.toContain(
      "sensitive",
    );
  });
});
