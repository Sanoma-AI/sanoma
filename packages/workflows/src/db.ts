import { type Client, Pool } from "pg";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The runtime's own tables live in the config's database, beside DBOS's: the credentials and the
// ledger. What they share is here: a pool that survives a dropped connection, and a table
// creation two processes may race.

/** A connection or a pool: what the queries take. */
export type Db = Pick<Pool | Client, "query">;

/** Postgres's codes for a row type or a table another process made first. */
const MADE_ALREADY = new Set(["23505", "42P07"]);

/** True for the failure of a create that another process won: what was to be made is there. */
export const madeAlready = (err: unknown): boolean => MADE_ALREADY.has((err as { code?: string } | null)?.code ?? "");

/**
 * A pool on the config's database for `what` (a word for the messages). An idle connection that
 * drops (Postgres restarted) is replaced on the next query; unheard, it would end the process.
 */
export function openPool(databaseUrl: string, what: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err) => warn(`a ${what} connection failed: ${errorMessage(err)}`));
  return pool;
}

/**
 * Runs `ddl` (`CREATE TABLE IF NOT EXISTS`, and the like) on `db`. Two processes racing to create
 * the same table both succeed; any other failure names the `what` table, with its cause.
 */
export async function createTable(db: Db, ddl: string, what: string): Promise<void> {
  try {
    await db.query(ddl);
  } catch (err) {
    if (madeAlready(err)) return;
    throw new Error(`could not prepare the ${what} table: ${errorMessage(err)}`, { cause: err });
  }
}
