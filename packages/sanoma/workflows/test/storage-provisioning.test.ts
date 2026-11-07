import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prepareSecretStore, type PrepareSecretStore } from "../src/storage-provisioning.ts";
import { defineWorkflow, memorySecretStore, memorySecrets, sanoma, SanomaClient } from "../src/index.ts";
import { runtimeDriver, sandboxRuntimeDriver } from "../src/runtime-ops.ts";
import { memoryTokens } from "../src/tokens.ts";
import { lazyDb } from "../src/db.ts";
import { rootWith } from "./harness.ts";
import { storeDatabaseUrl } from "../src/database.ts";

const rootUrl = new URL(testDatabaseUrl("storage"));
rootUrl.pathname = "/postgres";
const root = new Client({ connectionString: rootUrl.href });
const fixtures: { database: string; admin: string; role: string }[] = [];
const roleOf = (company: string, environment = "production") =>
  `sanoma_runtime_${createHash("sha256")
    .update(JSON.stringify([company, environment]))
    .digest("hex")
    .slice(0, 24)}`;
beforeAll(() => root.connect());
afterAll(async () => {
  for (const { database, admin, role } of fixtures) {
    await root.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
    await root.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    await root.query(`DROP ROLE IF EXISTS ${escapeIdentifier(admin)}`);
  }
  await root.end();
});
async function fixture() {
  const id = randomUUID().replaceAll("-", "").slice(0, 12),
    company = `company-${id}`;
  const admin = `storage_admin_${id}`,
    role = roleOf(company);
  const url = new URL(testDatabaseUrl(`sp_${id}`)),
    database = url.pathname.slice(1);
  fixtures.push({ database, admin, role });
  const password = randomBytes(32).toString("base64url");
  await root.query(`CREATE ROLE ${escapeIdentifier(admin)} LOGIN CREATEROLE PASSWORD ${escapeLiteral(password)}`);
  await root.query(`CREATE DATABASE ${escapeIdentifier(database)} OWNER ${escapeIdentifier(admin)}`);
  url.username = admin;
  url.password = password;
  const secrets = memorySecrets({ ADMIN: url.href });
  const input: PrepareSecretStore = {
    company,
    environment: "production",
    database: { $secret: "ADMIN" },
    store: "RUNTIME",
  };
  return { input, secrets, url: url.href, role, database };
}
async function using<T>(url: string, run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: url });
  try {
    await db.connect();
    return await run(db);
  } finally {
    await db.end();
  }
}

describe("trusted KMS database preparation", () => {
  it("prepares and retries storage from an uppercase database export containing digits", async () => {
    const f = await fixture();
    const exported = await storeDatabaseUrl(f.secrets, "CLOUD_S532_CONSUMER_97F9CE47", f.url, {
      where: "test database",
      others: "another database",
    });
    expect(exported).toEqual({ secret: "SANOMA_DATABASE_URL_CLOUD_S532_CONSUMER_97F9CE47" });
    const input = { ...f.input, database: { $secret: "SANOMA_DATABASE_URL_CLOUD_S532_CONSUMER_97F9CE47" } };
    const prepared = await prepareSecretStore(input, f.secrets);
    const runtimeUrl = await f.secrets.get("RUNTIME");
    expect(await prepareSecretStore(input, f.secrets)).toEqual(prepared);
    expect(await f.secrets.get("RUNTIME")).toBe(runtimeUrl);
    expect(await using(runtimeUrl!, async (db) => (await db.query("SELECT current_user AS role")).rows[0]?.role)).toBe(
      f.role,
    );
  });

  it("binds the login password outside SQL statement text and lets Postgres store a SCRAM verifier", async () => {
    const f = await fixture();
    const query = vi.spyOn(Client.prototype, "query");
    try {
      await prepareSecretStore(f.input, f.secrets);
      const password = new URL((await f.secrets.get("RUNTIME"))!).password;
      const calls = query.mock.calls as unknown as [{ text: string }, unknown[] | undefined][];
      expect(calls.map(([{ text }]) => text).join("\n")).not.toContain(password);
      expect(calls).toContainEqual([
        expect.objectContaining({ text: "SELECT pg_temp.sanoma_create_runtime($1, $2)" }),
        [f.role, password],
      ]);
      const { rows } = await root.query<{ scram: boolean }>(
        "SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname=$1",
        [f.role],
      );
      expect(rows[0]?.scram).toBe(true);
    } finally {
      query.mockRestore();
    }
  });

  it("creates a restricted login that runs Sanoma, keeps metadata private and denies another company database", async () => {
    const a = await fixture(),
      b = await fixture();
    const receipt = await prepareSecretStore(a.input, a.secrets);
    await prepareSecretStore(b.input, b.secrets);
    expect(receipt).toEqual({ company: a.input.company, environment: "production", role: a.role, store: "RUNTIME" });
    const runtime = (await a.secrets.get("RUNTIME"))!;
    expect(new URL(runtime).password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await using(runtime, async (db) => {
      await db.query(
        "INSERT INTO sanoma_kms.secrets(company,namespace,path,version,envelope,updated_by) VALUES($1,'production','probe',$2,'{}','test')",
        [a.input.company, randomUUID()],
      );
      expect((await db.query("SELECT company FROM sanoma_kms.secrets")).rows).toEqual([{ company: a.input.company }]);
      await expect(db.query("SELECT * FROM sanoma_kms.deployment")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(`ALTER ROLE ${escapeIdentifier(a.role)} CREATEROLE`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(db.query("CREATE ROLE forbidden_runtime_admin")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("TRUNCATE sanoma_kms.secrets")).rejects.toMatchObject({ code: "42501" });
    });
    const other = new URL(runtime);
    other.pathname = `/${b.database}`;
    await expect(using(other.href, async () => {})).rejects.toMatchObject({ code: "42501" });
    const client = await SanomaClient.connect({
      connectors: [],
      databaseUrl: runtime,
      secrets: { store: memorySecretStore() },
    });
    await client.close();
    // The runtime's own migrations do not acquire ownership of the private schema.
    await expect(using(runtime, (db) => db.query("DROP SCHEMA sanoma_kms CASCADE"))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("serializes duplicate requests and reuses the stored login after a lost response", async () => {
    const f = await fixture();
    const query = Client.prototype.query;
    let lost = false;
    const callQuery = query as (...args: unknown[]) => unknown;
    const intercepted = function (this: Client, ...args: unknown[]) {
      const result = callQuery.apply(this, args);
      if (/^commit$/i.test((args[0] as { text?: string } | undefined)?.text ?? "") && !lost) {
        lost = true;
        return Promise.resolve(result).then(() => {
          throw new Error(`lost response: ${f.url}`);
        });
      }
      return result;
    };
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(intercepted as typeof query);
    try {
      await expect(prepareSecretStore(f.input, f.secrets)).rejects.toMatchObject({
        message: "Storage provisioning: unavailable",
      });
    } finally {
      spy.mockRestore();
    }
    expect(lost).toBe(true);
    const committedCredential = await f.secrets.get("RUNTIME");
    const [first, second] = await Promise.all([
      prepareSecretStore(f.input, f.secrets),
      prepareSecretStore(f.input, f.secrets),
    ]);
    expect(first).toEqual(second);
    const held = await f.secrets.get("RUNTIME");
    expect(held).toBe(committedCredential);
    expect(await prepareSecretStore(f.input, f.secrets)).toEqual(first);
    expect(await f.secrets.get("RUNTIME")).toBe(held);
    await expect(prepareSecretStore({ ...f.input, company: "other" }, f.secrets)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(prepareSecretStore({ ...f.input, store: "DIFFERENT" }, f.secrets)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await using(held!, (db) => db.query("SELECT current_user"))).toMatchObject({
      rows: [{ current_user: f.role }],
    });
  });

  it("refuses an existing unowned role and rolls back schema changes", async () => {
    const f = await fixture();
    await root.query(`CREATE ROLE ${escapeIdentifier(f.role)}`);
    await expect(prepareSecretStore(f.input, f.secrets)).rejects.toMatchObject({ code: "conflict" });
    expect(await using(f.url, (db) => db.query("SELECT to_regnamespace('sanoma_kms') AS schema"))).toMatchObject({
      rows: [{ schema: null }],
    });
  });

  it("refuses privilege drift rather than adopting a role with database-administration authority", async () => {
    const f = await fixture();
    await prepareSecretStore(f.input, f.secrets);
    await root.query(`ALTER ROLE ${escapeIdentifier(f.role)} CREATEROLE`);
    await expect(prepareSecretStore(f.input, f.secrets)).rejects.toMatchObject({ code: "denied" });
    await root.query(`ALTER ROLE ${escapeIdentifier(f.role)} NOCREATEROLE`);
  });

  it("rejects URL authority overrides before saving or connecting, and sanitizes storage failures", async () => {
    const f = await fixture();
    const url = new URL(f.url);
    url.searchParams.set("user", "postgres");
    const secrets = memorySecrets({ ADMIN: url.href });
    await expect(prepareSecretStore(f.input, secrets)).rejects.toMatchObject({ code: "invalid" });
    expect(await secrets.get("RUNTIME")).toBeUndefined();
    await expect(
      prepareSecretStore(f.input, {
        ...secrets,
        get: async () => {
          throw new Error(f.url);
        },
      }),
    ).rejects.toMatchObject({ message: "Storage provisioning: unavailable" });
  });

  it("keeps backend diagnostics out of operation errors and uses an in-memory sandbox", async () => {
    const f = await fixture();
    const call = {
      idempotencyKey: "storage:1",
      runId: "storage",
      opId: "sanoma.secretStore.prepare",
      attempt: 1,
      secrets: f.secrets,
      by: "ada",
    };
    const driver = runtimeDriver({
      tokens: memoryTokens(),
      storage: async () => {
        throw new Error(`credential: ${f.url}`);
      },
    });
    await expect(driver.ops["secretStore.prepare"]!(f.input, call)).rejects.toMatchObject({
      message: "Storage provisioning: unavailable",
      retryable: true,
    });
    const connect = vi.spyOn(Client.prototype, "connect");
    try {
      expect(await sandboxRuntimeDriver().ops["secretStore.prepare"]!(f.input, call)).toMatchObject({
        role: f.role,
        store: "RUNTIME",
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});

const prepare = defineWorkflow({
  name: "prepare-managed-storage",
  trigger: "manual",
  input: z.object({ company: z.string(), store: z.string() }),
  uses: [sanoma.secretStore.prepare],
  run: async (ctx, input) =>
    await ctx.sanoma.secretStore.prepare({
      ...input,
      environment: "production",
      database: { $secret: "PROVISIONING_DATABASE" },
    }),
});
describe("storage provisioning workflow boundary", () => {
  const store = memorySecretStore();
  const databaseUrl = testDatabaseUrl("storage_workflow");
  const history = lazyDb(databaseUrl, "storage-history");
  const app = useTestApp(
    {
      connectors: [],
      workflows: [prepare],
      secrets: { store },
      root: rootWith({
        "policies/storage.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.secretStore.prepare", resource) when { context.input.company == "denied-company" };`,
      }),
    },
    { databaseUrl },
  );
  afterAll(() => history.close());
  it("prepares under policy without checkpointing credentials, and refuses unauthorized and direct calls", async () => {
    const f = await fixture();
    await app.client.setSecret("PROVISIONING_DATABASE", f.url, { by: "ada" });
    const run = await app.client.start(
      prepare,
      { company: f.input.company, store: "MANAGED_RUNTIME" },
      { startedBy: "ada" },
    );
    expect(await app.client.result(run)).toMatchObject({
      company: f.input.company,
      role: f.role,
      store: "MANAGED_RUNTIME",
    });
    const runtime = (await store.read({ namespace: "default", path: "MANAGED_RUNTIME" }))!.value;
    const forbidden = [f.url, new URL(f.url).password, runtime, new URL(runtime).password];
    const ledger = JSON.stringify(await app.client.ledger(run));
    expect(ledger).toContain("sanoma.secretStore.prepare");
    for (const value of forbidden) expect(ledger).not.toContain(value);
    for (const table of ["dbos.operation_outputs", "dbos.workflow_status"]) {
      const rows = JSON.stringify(
        (await (await history.db()).execute(sql`SELECT row_to_json(t) FROM ${sql.raw(table)} t`)).rows,
      );
      for (const value of forbidden) expect(rows).not.toContain(value);
    }
    const denied = await app.client.start(
      prepare,
      { company: "denied-company", store: "DENIED_RUNTIME" },
      { startedBy: "ada" },
    );
    await expect(app.client.result(denied)).rejects.toMatchObject({ code: "policy_denied" });
    expect(await store.read({ namespace: "default", path: "DENIED_RUNTIME" })).toBeUndefined();
    await expect(
      app.client.call("sanoma.secretStore.prepare", { ...f.input, store: "DIRECT_RUNTIME" }, { actor: "ada" }),
    ).rejects.toThrow(/cannot be called directly/);
    expect(await store.read({ namespace: "default", path: "DIRECT_RUNTIME" })).toBeUndefined();
  });
});
