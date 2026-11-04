import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "../db.ts";
import companyJournal from "../../drizzle/company/meta/_journal.json" with { type: "json" };
import wakeupJournal from "../../drizzle/wakeup/meta/_journal.json" with { type: "json" };

// The generated migrations (`pnpm --filter @sanoma-ai/workflows generate`), one folder per
// database the runtime makes tables in, each with its own journal table in the schema `drizzle`,
// since the wakeup service's database may be a company's own. The Worker, which never migrates,
// checks a database against the journal shipped with the package (`migrationsApplied`), with no
// file read: the journal is imported.

/** Drizzle's journal, `meta/_journal.json` of a migrations folder. */
export interface MigrationsJournal {
  entries: { idx: number; when: number; tag: string }[];
}

/** A migrations folder with the journal table recording what of it a database has. */
export interface Migrations {
  /** The folder's name under the package's `drizzle/`. */
  name: string;
  /** Its journal table in the schema `drizzle`. */
  table: string;
  journal: MigrationsJournal;
}

/** The folder of `of`, from `src/` and from `dist/` alike; read only when migrating, never in the Worker. */
const folderOf = (of: Migrations): string => fileURLToPath(new URL(`../../drizzle/${of.name}/`, import.meta.url));

/** The tables every company database gets (`db/company.ts`). */
export const COMPANY_MIGRATIONS = {
  name: "company",
  table: "__drizzle_migrations",
  journal: companyJournal,
} satisfies Migrations;

/** The wakeup service's tables (`db/wakeup.ts`). */
export const WAKEUP_MIGRATIONS = {
  name: "wakeup",
  table: "__drizzle_migrations_wakeup",
  journal: wakeupJournal,
} satisfies Migrations;

/**
 * Applies to `db` the migrations of `of` its database has not had, in one transaction, recording
 * each in the journal table. Drizzle's migrator compares only the newest timestamp, so a migration
 * older than the newest applied is skipped: `scripts/check-journal.ts` keeps a branch from adding
 * one. Two processes migrating one database at once race (the migrator takes no lock): callers
 * hold `underPreparationLock`.
 */
export const applyMigrations = (db: Db, of: Migrations): Promise<void> =>
  migrate(db, { migrationsFolder: folderOf(of), migrationsTable: of.table });

/**
 * Whether the database `db` is on has had every migration of `of`: each journal entry's `when`
 * is a `created_at` of its journal table, whatever else the table holds (a database a newer
 * release migrated serves this one, as after a rollback). False with no journal table.
 */
export async function migrationsApplied(db: Db, of: Migrations): Promise<boolean> {
  const present = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`drizzle.${of.table}`}) IS NOT NULL AS present`,
  );
  if (present.rows[0]?.present !== true) return false;
  const { rows } = await db.execute<{ at: string }>(
    sql`SELECT created_at::text AS at FROM drizzle.${sql.identifier(of.table)}`,
  );
  const applied = new Set(rows.map((row) => Number(row.at)));
  return of.journal.entries.every((entry) => applied.has(entry.when));
}
