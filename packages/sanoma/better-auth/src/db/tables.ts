import { bigint, boolean, index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

// Better Auth's tables, as its Drizzle adapter reads them: the properties are its field names,
// the columns their snake_case (`casing`, as the runtime's `databaseOn` and `drizzle/*.config.ts`
// have it), plus the user's `github` (`TABLE_OPTIONS` in `instance.ts`). Each login has the set in
// a schema of its own (`visitors.ts`, `staff.ts`), from which drizzle-kit generates its
// migrations, so a change here is a new migration in both folders: `pnpm --filter
// sanoma generate`. Row-level security is on with no policy, as on the runtime's own tables
// (`sanoma/workflows`' `db/company.ts`).

const when = () => timestamp({ withTimezone: true });

/** Better Auth's tables in the schema `name`, by its model names, as `drizzleAdapter` takes them; `schema` is the schema itself. */
export function loginTables<Name extends string>(name: Name) {
  const schema = pgSchema(name);
  const user = schema
    .table("user", {
      id: text().primaryKey(),
      name: text().notNull(),
      email: text().notNull().unique(),
      emailVerified: boolean().notNull().default(false),
      image: text(),
      createdAt: when().notNull().defaultNow(),
      updatedAt: when().notNull().defaultNow(),
      /** The GitHub login the account is said to be; the login's own to set, never a person's input. */
      github: text(),
    })
    .enableRLS();
  const session = schema
    .table(
      "session",
      {
        id: text().primaryKey(),
        expiresAt: when().notNull(),
        token: text().notNull().unique(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
        ipAddress: text(),
        userAgent: text(),
        userId: text()
          .notNull()
          .references(() => user.id, { onDelete: "cascade" }),
      },
      (t) => [index().on(t.userId)],
    )
    .enableRLS();
  const account = schema
    .table(
      "account",
      {
        id: text().primaryKey(),
        accountId: text().notNull(),
        providerId: text().notNull(),
        userId: text()
          .notNull()
          .references(() => user.id, { onDelete: "cascade" }),
        accessToken: text(),
        refreshToken: text(),
        idToken: text(),
        accessTokenExpiresAt: when(),
        refreshTokenExpiresAt: when(),
        scope: text(),
        password: text(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
      },
      (t) => [index().on(t.userId)],
    )
    .enableRLS();
  const verification = schema
    .table(
      "verification",
      {
        id: text().primaryKey(),
        identifier: text().notNull(),
        value: text().notNull(),
        expiresAt: when().notNull(),
        createdAt: when().notNull().defaultNow(),
        updatedAt: when().notNull().defaultNow(),
      },
      (t) => [index().on(t.identifier)],
    )
    .enableRLS();
  /** The rate limit's counts (`rateLimit.storage: "database"`), one row per key. */
  const rateLimit = schema
    .table("rate_limit", {
      id: text().primaryKey(),
      key: text().notNull().unique(),
      count: integer().notNull(),
      lastRequest: bigint({ mode: "number" }).notNull(),
    })
    .enableRLS();
  return { schema, user, session, account, verification, rateLimit };
}
