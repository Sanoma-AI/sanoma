import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
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

const migrations = (name: string, table: string, journal: MigrationsJournal): Migrations => ({ name, table, journal });

/** The folder of `of`, from `src/` and from `dist/` alike; read only when migrating, never in the Worker. */
const folderOf = (of: Migrations): string => fileURLToPath(new URL(`../../drizzle/${of.name}/`, import.meta.url));

/** The tables every company database gets (`db/company.ts`). */
export const COMPANY_MIGRATIONS = migrations("company", "__drizzle_migrations", companyJournal);

/** The wakeup service's tables (`db/wakeup.ts`). */
export const WAKEUP_MIGRATIONS = migrations("wakeup", "__drizzle_migrations_wakeup", wakeupJournal);

/**
 * Applies to `db` the migrations of `of` its database has not had, in one transaction, recording
 * each in the journal table. Drizzle's migrator compares only the newest timestamp, so a migration
 * older than the newest applied is skipped: `scripts/check-journal.ts` keeps a branch from adding
 * one. Two processes migrating one database at once race (the migrator takes no lock): callers
 * hold `lockPreparation`.
 */
export const applyMigrations = (db: NodePgDatabase, of: Migrations): Promise<void> =>
  migrate(db, { migrationsFolder: folderOf(of), migrationsTable: of.table });

/**
 * Whether the database `db` is on has had every migration of `of`: its journal table's newest
 * `created_at` is the journal's last entry's `when`. False with no journal table.
 */
export async function migrationsApplied(db: PgDatabase<NodePgQueryResultHKT>, of: Migrations): Promise<boolean> {
  const last = of.journal.entries.at(-1);
  if (!last) return true;
  const table = sql`drizzle.${sql.identifier(of.table)}`;
  const present = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`drizzle.${of.table}`}) IS NOT NULL AS present`,
  );
  if (present.rows[0]?.present !== true) return false;
  const { rows } = await db.execute<{ newest: string | null }>(
    sql`SELECT max(created_at)::text AS newest FROM ${table}`,
  );
  return rows[0]?.newest === String(last.when);
}
