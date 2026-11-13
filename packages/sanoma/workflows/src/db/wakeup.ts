import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// The wakeup service's tables (`wakeup-service.ts`), in the service's own database: never a
// company's, which every company database gets. Migrations under `drizzle/wakeup/`. Row-level
// security is on with no policy, as on a company's (`company.ts`).

const when = () => timestamp({ withTimezone: true });

/** One account per party that registers instances, its token's hash alone. */
export const wakeupAccounts = pgTable("sanoma_wakeup_accounts", {
  id: uuid().primaryKey(),
  tokenHash: text().notNull().unique(),
  label: text().notNull(),
  createdAt: when().notNull().defaultNow(),
  revokedAt: when(),
}).enableRLS();

/** Each registered instance: its URL, its token's hash and its registered wake. */
export const wakeupInstances = pgTable(
  "sanoma_wakeup_instances",
  {
    id: uuid().primaryKey(),
    accountId: uuid()
      .notNull()
      .references(() => wakeupAccounts.id),
    url: text().notNull(),
    tokenHash: text().notNull().unique(),
    at: when(),
    calledAt: when(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: when(),
    lastError: text(),
    createdAt: when().notNull().defaultNow(),
  },
  (t) => [
    index("sanoma_wakeup_instances_at")
      .on(t.at)
      .where(sql`${t.at} IS NOT NULL`),
    index("sanoma_wakeup_instances_account").on(t.accountId),
  ],
).enableRLS();
