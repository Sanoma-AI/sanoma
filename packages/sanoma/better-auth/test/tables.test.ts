import { getAuthTables } from "better-auth/db";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as staff from "../src/db/staff.ts";
import * as visitors from "../src/db/visitors.ts";
import { TABLE_OPTIONS } from "../src/instance.ts";

// Better Auth's own migrations are never run (the tables are declared, and the adapter reads
// them), so this is where a field a `better-auth` release adds to a model, or one of the logins'
// plugins (the email code, the staff's magic links) brings, is found: before a sign-in fails on it.

/** Better Auth's models for the two logins' options and plugins, as `getAuthTables` lays them out. */
const models = getAuthTables({
  ...TABLE_OPTIONS,
  plugins: [emailOTP({ async sendVerificationOTP() {} }), magicLink({ async sendMagicLink() {} })],
});

/** The modules drizzle-kit reads, by their top-level exports: a table either leaves out has no migration. */
const logins: Record<string, Record<string, unknown>> = { visitors, staff };

describe("the tables", () => {
  it("declare every model Better Auth has, with its id, and every field, required and unique where it is", () => {
    expect(Object.keys(models).toSorted()).toEqual(["account", "rateLimit", "session", "user", "verification"]);
    for (const [login, declared] of Object.entries(logins))
      for (const [model, { fields }] of Object.entries(models)) {
        const table = declared[model];
        expect(is(table, PgTable), `${login}.${model}`).toBe(true);
        const columns = getTableColumns(table as PgTable);
        expect(columns.id?.primary, `${login}.${model}.id`).toBe(true);
        for (const [field, { required, unique }] of Object.entries(fields)) {
          const column = columns[field];
          expect(column, `${login}.${model}.${field}`).toBeDefined();
          expect(column!.notNull, `${login}.${model}.${field} required`).toBe(required === true);
          expect(column!.isUnique, `${login}.${model}.${field} unique`).toBe(unique === true);
        }
      }
  });

  it("declare no column Better Auth does not read", () => {
    for (const [login, declared] of Object.entries(logins))
      for (const [model, { fields }] of Object.entries(models)) {
        const extra = Object.keys(getTableColumns(declared[model] as PgTable)).filter(
          (c) => c !== "id" && !(c in fields),
        );
        expect(extra, `${login}.${model}`).toEqual([]);
      }
  });
});
