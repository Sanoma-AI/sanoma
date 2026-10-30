import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkSecretStore, SecretAccess } from "@sanoma-ai/workflows";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseVault } from "../src/vault.ts";

// Opt-in, isolated database. Requires an administrator allowed to create a database and login.
// No production namespaces or secrets are accessed; every value is synthetic.
const url = process.env.SANOMA_VAULT_TEST_DATABASE_URL;
const id = `vault_test_${randomUUID().replaceAll("-", "")}`;
const login = `${id}_app`;
const password = randomUUID();
let admin: Client;
let db: Client;
let scoped: Client;
let store: ReturnType<typeof supabaseVault>;
let second: ReturnType<typeof supabaseVault>;
let madeDatabase = false;
let madeRole = false;

describe.runIf(Boolean(url))("Supabase Vault SQL boundary (actual extension)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${id}`);
    madeDatabase = true;
    const target = new URL(url!);
    target.pathname = `/${id}`;
    db = new Client({ connectionString: target.toString() });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE");
    // A superuser would hide hosted Supabase privilege failures (notably FOR UPDATE).
    const privileges = await db.query(
      "SELECT rolsuper, has_table_privilege(current_user, 'vault.secrets', 'UPDATE') AS can_update FROM pg_roles WHERE rolname = current_user",
    );
    if (privileges.rows[0]?.rolsuper !== false || privileges.rows[0]?.can_update !== false)
      throw new Error("Vault proof requires the standard non-superuser Supabase administrator without direct UPDATE");
    await db.query(readFileSync(new URL("../sql/vault.sql", import.meta.url), "utf8"));
    // Test-only generated identifiers and password; no customer material is interpolated.
    await db.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    madeRole = true;
    await db.query(`GRANT USAGE ON SCHEMA sanoma_vault TO ${login}`);
    await db.query(`GRANT EXECUTE ON FUNCTION sanoma_vault.access(text,text,text,text,text,text) TO ${login}`);
    await db.query(
      "INSERT INTO sanoma_vault.namespaces(login,namespace,writable) VALUES ($1,'check',true),($1,'check-other',true)",
      [login],
    );
    target.username = login;
    target.password = password;
    process.env.SANOMA_VAULT_SCOPED_TEST_URL = target.toString();
    scoped = new Client({ connectionString: target.toString() });
    await scoped.connect();
    store = supabaseVault({ databaseUrlEnv: "SANOMA_VAULT_SCOPED_TEST_URL" });
    second = supabaseVault({ databaseUrlEnv: "SANOMA_VAULT_SCOPED_TEST_URL" });
  }, 60_000);
  afterAll(async () => {
    await store?.close();
    await second?.close();
    await scoped?.end();
    await db?.end();
    delete process.env.SANOMA_VAULT_SCOPED_TEST_URL;
    if (madeDatabase) await admin.query(`DROP DATABASE ${id} WITH (FORCE)`);
    if (madeRole) await admin.query(`DROP ROLE ${login}`);
    await admin?.end();
  });

  it("passes store conformance including concurrent create, stale CAS, namespace separation and deletion", async () => {
    const results = await checkSecretStore(store, "check");
    expect(results.length).toBeGreaterThan(5);
    expect(results.every((r) => r.ok)).toBe(true);
  });
  it("denies raw decrypted tables, grant modification, cross-namespace access and unsafe administrator identities", async () => {
    await expect(scoped.query("SELECT decrypted_secret FROM vault.decrypted_secrets")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(scoped.query("UPDATE sanoma_vault.namespaces SET writable = true")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(store.read({ namespace: "someone-else", path: "RACE" })).rejects.toMatchObject({ code: "denied" });
    await db.query("INSERT INTO sanoma_vault.namespaces(login,namespace) VALUES (session_user,'admin-check')");
    await expect(db.query("SELECT sanoma_vault.access('validate','admin-check')")).rejects.toMatchObject({
      code: "42501",
    });
  });
  it("keeps ciphertext at rest and lets only one independent client replace an observed version", async () => {
    const address = { namespace: "check", path: "CONFLICT" };
    const first = await store.write(address, "synthetic initial", { expectedVersion: null, by: "test" });
    const results = await Promise.allSettled(
      [store, second].map((s, i) => s.write(address, `synthetic ${i}`, { expectedVersion: first.version, by: "test" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { code: "conflict" } }]);
    const rows = await db.query("SELECT secret FROM vault.secrets");
    expect(rows.rows.every((r) => !r.secret.includes("synthetic"))).toBe(true);
    const current = (await store.read(address))!;
    const same = await store.write(address, current.value, { expectedVersion: current.version, by: "test" });
    expect(same.version).not.toBe(current.version);
  });
  it("reads existing secrets but refuses mutations even if company code claims ownership", async () => {
    const existing = await db.query("SELECT vault.create_secret('synthetic external','customer-secret') AS id");
    const secretId = existing.rows[0].id;
    await db.query(
      "INSERT INTO sanoma_vault.external_secrets(login,namespace,path,secret_id) VALUES ($1,'check','EXTERNAL',$2)",
      [login, secretId],
    );
    const address = { namespace: "check", path: "EXTERNAL" };
    const first = (await store.read(address))!;
    expect(first.value).toBe("synthetic external");
    await expect(store.write(address, "wrong", { expectedVersion: first.version, by: "test" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(store.delete(address, { expectedVersion: first.version, by: "test" })).rejects.toMatchObject({
      code: "read_only",
    });
    await db.query("SELECT vault.update_secret($1,'synthetic rotated')", [secretId]);
    const rotated = (await second.read(address))!;
    expect(rotated.value).toBe("synthetic rotated");
    expect(rotated.version).not.toBe(first.version);
    const access = new SecretAccess(
      { store, namespace: "check", bindings: { EXTERNAL: { path: "EXTERNAL", management: "external" } } },
      store,
    );
    await expect(
      access.write("EXTERNAL", "wrong", { expectedVersion: rotated.version, by: "test" }),
    ).rejects.toMatchObject({ code: "read_only" });
    await db.query("DELETE FROM vault.secrets WHERE id=$1", [secretId]);
    expect(await store.read(address)).toBeUndefined();
  });
  it("detects updates through Vault outside the adapter and refuses a stale replacement", async () => {
    const address = { namespace: "check", path: "OUTSIDE" };
    const first = await store.write(address, "before", { expectedVersion: null, by: "test" });
    await db.query("SELECT vault.update_secret(id, 'outside') FROM vault.secrets WHERE name LIKE '%/OUTSIDE'");
    await expect(second.write(address, "stale", { expectedVersion: first.version, by: "test" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await store.read(address))?.value).toBe("outside");
    expect((await store.read(address))?.updatedBy).toBeUndefined();
  });
  it("waits for an ordinary Vault writer and rejects the version it replaced", async () => {
    const address = { namespace: "check", path: "OUTSIDE_CONCURRENT" };
    const first = await store.write(address, "before", { expectedVersion: null, by: "test" });
    await db.query("BEGIN");
    let attempted: Promise<unknown> | undefined;
    try {
      await db.query(
        "SELECT vault.update_secret(id, 'outside concurrent') FROM vault.secrets WHERE name LIKE '%/OUTSIDE_CONCURRENT'",
      );
      // Attach the rejection handler immediately; the caller waits on Vault's table lock.
      attempted = second
        .write(address, "stale", { expectedVersion: first.version, by: "test" })
        .catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const locks = await db.query(
            "SELECT 1 FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND relation = 'vault.secrets'::regclass AND NOT granted",
          );
          return locks.rowCount;
        })
        .toBe(1);
      await db.query("COMMIT");
      expect(await attempted).toMatchObject({ code: "conflict" });
      expect((await store.read(address))?.value).toBe("outside concurrent");
    } finally {
      await db.query("ROLLBACK");
      await attempted;
    }
  });
});
