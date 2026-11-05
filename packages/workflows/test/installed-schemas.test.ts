import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type { Client } from "pg";
import { afterAll, expect, it } from "vitest";
import { CLOUD_IDENTITY_SQL } from "../src/cloud-identity.ts";
import { connectMaking, databaseOn, type Db } from "../src/db.ts";
import * as identity from "../src/db/identity.ts";
import * as kms from "../src/db/kms.ts";
import { CLOUD_IDENTITY_AUDIT_SQL } from "../src/identity-service.ts";
import { KMS_SECRETS_SQL } from "../src/kms-secrets.ts";
import { BINDING_SQL } from "../src/storage-provisioning.ts";
import { freshDatabase } from "./harness.ts";

// The schemas an administrator installs (with their grants and roles) are never migrated, so
// `db/kms.ts` and `db/identity.ts` are a second statement of each, the one the runtime queries:
// this holds each to its install SQL, column for column and constraint for constraint.

const installed = freshDatabase("installed_schemas");
const declared = freshDatabase("declared_schemas");
const opened: Client[] = [];
afterAll(() => Promise.all(opened.map((client) => client.end())));

async function connected(url: string): Promise<Db> {
  const client = await connectMaking(url);
  opened.push(client);
  return databaseOn(client);
}

/**
 * The schema's columns in order, and its constraints, names aside: the install SQL's defaults on one side, the
 * declaration's on the other. Not-null constraints (`contype = 'n'`, which Postgres 18 lists and 17 does not) are
 * the columns' `is_nullable`.
 */
async function shape(db: Db, schema: string) {
  const columns = await db.execute(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
    FROM information_schema.columns WHERE table_schema = ${schema}
    ORDER BY table_name, ordinal_position`);
  const constraints = await db.execute(sql`
    SELECT conrelid::regclass::text AS "table", contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace = ${schema}::regnamespace AND contype <> 'n'
    ORDER BY 1, 2, 3`);
  return { columns: columns.rows, constraints: constraints.rows };
}

it.each([
  { schema: "sanoma_kms", declaration: kms, install: KMS_SECRETS_SQL + BINDING_SQL, columns: 12, constraints: 3 },
  {
    schema: "sanoma_identity",
    declaration: identity,
    install: CLOUD_IDENTITY_SQL + CLOUD_IDENTITY_AUDIT_SQL,
    columns: 20,
    constraints: 10,
  },
])("declares the tables of $schema its install SQL makes", async ({ schema, declaration, install, ...counts }) => {
  const [a, b] = await Promise.all([connected(installed), connected(declared)]);
  await a.execute(sql.raw(install));
  const statements = await generateMigration(
    generateDrizzleJson({}, undefined, [schema], "snake_case"),
    generateDrizzleJson(declaration, undefined, [schema], "snake_case"),
  );
  for (const statement of statements) await b.execute(sql.raw(statement));
  const expected = await shape(a, schema);
  expect(expected.columns).toHaveLength(counts.columns);
  expect(expected.constraints).toHaveLength(counts.constraints);
  expect(await shape(b, schema)).toEqual(expected);
});
