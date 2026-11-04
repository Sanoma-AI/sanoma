import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, expect, it } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { CLOUD_IDENTITY_SQL } from "../src/cloud-identity.ts";
import { lazyDb, type Db } from "../src/db.ts";
import * as schema from "../src/db/identity.ts";
import { CLOUD_IDENTITY_AUDIT_SQL } from "../src/identity-service.ts";

// The broker's tables are installed by an administrator from `CLOUD_IDENTITY_SQL` (with grants and
// roles) and never migrated, so `db/identity.ts` is a second statement of the same schema: this
// holds it to the install text, column for column and constraint for constraint.

const installed = lazyDb(testDatabaseUrl("identity_schema_installed"), "identity-schema-installed");
const declared = lazyDb(testDatabaseUrl("identity_schema_declared"), "identity-schema-declared");
afterAll(() => Promise.all([installed.close(), declared.close()]));

async function shape(db: Db) {
  const columns = await db.execute(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'sanoma_identity'
    ORDER BY table_name, column_name`);
  // Constraint names are the install SQL's defaults on one side and the declaration's on the other.
  const constraints = await db.execute(sql`
    SELECT conrelid::regclass::text AS "table", contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace = 'sanoma_identity'::regnamespace
    ORDER BY 1, 2, 3`);
  return { columns: columns.rows, constraints: constraints.rows };
}

it("declares the tables the install SQL makes", async () => {
  const [a, b] = await Promise.all([installed.db(), declared.db()]);
  for (const db of [a, b]) await db.execute(sql`DROP SCHEMA IF EXISTS sanoma_identity CASCADE`);
  await a.execute(sql.raw(CLOUD_IDENTITY_SQL + CLOUD_IDENTITY_AUDIT_SQL));
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema, undefined, undefined, "snake_case"),
  );
  for (const statement of statements) await b.execute(sql.raw(statement));
  const [install, declaration] = [await shape(a), await shape(b)];
  expect(install.columns).toHaveLength(20);
  expect(install.constraints.length).toBeGreaterThanOrEqual(10);
  expect(declaration).toEqual(install);
});
