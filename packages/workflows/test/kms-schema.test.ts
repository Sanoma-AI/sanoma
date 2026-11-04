import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client, escapeIdentifier } from "pg";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseOn } from "../src/db.ts";
import * as kmsSchema from "../src/db/kms.ts";
import { KMS_SECRETS_SQL } from "../src/kms-secrets.ts";
import { BINDING_SQL } from "../src/storage-provisioning.ts";

// The tables are installed by an administrator from `KMS_SECRETS_SQL` and `BINDING_SQL`, never
// migrated at runtime; `src/db/kms.ts` is what the runtime queries. Both must describe the same tables.

const installed = new URL(testDatabaseUrl("kms_parity_installed"));
const declared = new URL(testDatabaseUrl("kms_parity_declared"));
const root = new Client({ connectionString: Object.assign(new URL(installed), { pathname: "/postgres" }).href });
const open: Client[] = [];

async function fresh(url: URL) {
  const name = url.pathname.slice(1);
  await root.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  const client = new Client({ connectionString: url.href });
  await client.connect();
  open.push(client);
  return databaseOn(client);
}

const catalog = async (db: Awaited<ReturnType<typeof fresh>>) => ({
  columns: (
    await db.execute(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns WHERE table_schema = 'sanoma_kms'
      ORDER BY table_name, ordinal_position`)
  ).rows,
  constraints: (
    await db.execute(sql`
      SELECT c.conrelid::regclass::text AS "table", c.contype, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'sanoma_kms'
      ORDER BY 1, 2, 3`)
  ).rows,
});

beforeAll(() => root.connect());
afterAll(async () => {
  await Promise.all(open.map((client) => client.end()));
  for (const url of [installed, declared])
    await root.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(url.pathname.slice(1))} WITH (FORCE)`);
  await root.end();
});

describe("KMS schema", () => {
  it("is the same in the install SQL and in src/db/kms.ts", async () => {
    const a = await fresh(installed);
    await a.execute(sql.raw(KMS_SECRETS_SQL));
    await a.execute(sql.raw(BINDING_SQL));

    const b = await fresh(declared);
    const snapshot = generateDrizzleJson(kmsSchema, undefined, ["sanoma_kms"], "snake_case");
    const empty = generateDrizzleJson({}, undefined, ["sanoma_kms"], "snake_case");
    for (const statement of await generateMigration(empty, snapshot)) await b.execute(sql.raw(statement));

    const expected = await catalog(a);
    expect(expected.columns).toHaveLength(12);
    expect(expected.constraints).toHaveLength(3);
    expect(await catalog(b)).toEqual(expected);
  });
});
