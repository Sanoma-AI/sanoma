import { getAuthTables } from "better-auth/db";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { loginTables } from "../src/db/tables.ts";
import { TABLE_OPTIONS } from "../src/instance.ts";

// Better Auth's own migrations are never run (the tables are declared, and the adapter reads
// them), so this is where a field a `better-auth` release adds to a model, or one of the logins'
// plugins (the email code, the staff's magic links) brings, is found: before a sign-in fails on it.

/** Better Auth's models for the two logins' options and plugins, as `getAuthTables` lays them out. */
const models = getAuthTables({
  ...TABLE_OPTIONS,
  plugins: [emailOTP({ async sendVerificationOTP() {} }), magicLink({ async sendMagicLink() {} })],
});

const declared: Record<string, unknown> = loginTables("better_auth");

describe("the tables", () => {
  it("declare every model Better Auth has, with its id, and every field, required and unique where it is", () => {
    expect(Object.keys(models).toSorted()).toEqual(["account", "rateLimit", "session", "user", "verification"]);
    for (const [model, { fields }] of Object.entries(models)) {
      const table = declared[model];
      expect(is(table, PgTable), model).toBe(true);
      const columns = getTableColumns(table as PgTable);
      expect(columns.id?.primary, `${model}.id`).toBe(true);
      for (const [field, { required, unique }] of Object.entries(fields)) {
        const column = columns[field];
        expect(column, `${model}.${field}`).toBeDefined();
        expect(column!.notNull, `${model}.${field} required`).toBe(required === true);
        expect(column!.isUnique, `${model}.${field} unique`).toBe(unique === true);
      }
    }
  });

  it("declare no column Better Auth does not read", () => {
    for (const [model, { fields }] of Object.entries(models)) {
      const extra = Object.keys(getTableColumns(declared[model] as PgTable)).filter(
        (c) => c !== "id" && !(c in fields),
      );
      expect(extra, model).toEqual([]);
    }
  });

  it("are the same set in either schema, each in its own", () => {
    const visitors = loginTables("better_auth");
    const staff = loginTables("better_auth_staff");
    expect(staff.schema.schemaName).toBe("better_auth_staff");
    for (const model of Object.keys(models) as (keyof typeof visitors)[]) {
      if (model === "schema") continue;
      expect(getTableName(staff[model])).toBe(getTableName(visitors[model]));
      expect(Object.keys(getTableColumns(staff[model]))).toEqual(Object.keys(getTableColumns(visitors[model])));
    }
  });
});
