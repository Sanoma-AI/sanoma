import { DBOS } from "@dbos-inc/dbos-sdk";
import { Client, Pool } from "pg";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The runtime's own tables live in the config's database, beside DBOS's: the credentials and the
// ledger. What they share is here: the one preparation of a database, a pool that opens once it
// is prepared and survives a dropped connection, and a table creation two processes may race.

/** A connection or a pool: what the queries take. */
export type Db = Pick<Pool | Client, "query">;

/** Where the credentials set from the app live. */
export const CREDENTIALS_TABLE = "sanoma_credentials";
/** Where the Postgres ledger keeps its records. */
export const LEDGER_TABLE = "sanoma_ledger";

/** The runtime's tables, each with the word the messages name it by. */
const TABLES: readonly [what: string, ddl: string][] = [
  [
    "credentials",
    `CREATE TABLE IF NOT EXISTS ${CREDENTIALS_TABLE} (name text PRIMARY KEY, value text NOT NULL, ` +
      "set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())",
  ],
  [
    "ledger",
    // `n` is the write order, `id` the record's, which the first write of takes, and `seq` the
    // record's place in its run: a run reads in `seq` order, then write order.
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (n bigserial PRIMARY KEY, id text NOT NULL UNIQUE, ` +
      `run_id text NOT NULL, seq integer NOT NULL, record jsonb NOT NULL); ` +
      `CREATE INDEX IF NOT EXISTS ${LEDGER_TABLE}_run_seq ON ${LEDGER_TABLE} (run_id, seq, n)`,
  ],
];

/** The Postgres error code of `err`, or an empty string when it has none. */
export const pgCode = (err: unknown): string => (err as { code?: unknown } | null)?.code?.toString() ?? "";

/** Postgres's codes for a row type or a table another process made first. */
const MADE_ALREADY = new Set(["23505", "42P07"]);

/** True for the failure of a create that another process won: what was to be made is there. */
export const madeAlready = (err: unknown): boolean => MADE_ALREADY.has(pgCode(err));

/**
 * A pool on the config's database for `what` (a word for the messages). An idle connection that
 * drops (Postgres restarted) is replaced on the next query; unheard, it would end the process.
 */
export function openPool(databaseUrl: string, what: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err) => warn(`a ${what} connection failed: ${errorMessage(err)}`));
  return pool;
}

/** A pool opened on first use, once its database is prepared, and ended by `close`. */
export interface LazyPool {
  db(): Promise<Pool>;
  close(): Promise<void>;
}

/**
 * A pool for `what` on the database at `databaseUrl`, opened on the first `db()` once the
 * database is prepared (`prepareDatabase`). A preparation that fails lets the pool go, so the
 * next `db()` tries again. `close` ends the pool, for good: a `db()` after it is refused.
 */
export function lazyPool(databaseUrl: string, what: string): LazyPool {
  let pool: Pool | undefined;
  let closed = false;
  return {
    async db() {
      if (closed) throw new Error(`the ${what} store is closed`);
      const current = (pool ??= openPool(databaseUrl, what));
      try {
        await prepareDatabase(databaseUrl);
      } catch (err) {
        if (pool === current) pool = undefined;
        await current.end().catch(() => undefined);
        throw err;
      }
      return current;
    },
    async close() {
      closed = true;
      const current = pool;
      pool = undefined;
      await current?.end();
    },
  };
}

/** Each database prepared, or being prepared, by its URL. A failed preparation is forgotten. */
const prepared = new Map<string, Promise<void>>();

/**
 * Makes the database at `databaseUrl` ready for the runtime, once per process and URL: the
 * database itself and DBOS's tables when they are not there yet (as a worker's launch makes
 * them; credentials may be set, and a ledger read, before any worker has run), then the
 * credentials and ledger tables. Two processes preparing one database both succeed. A
 * preparation that fails is forgotten, so the next call tries again.
 */
export function prepareDatabase(databaseUrl: string): Promise<void> {
  let preparing = prepared.get(databaseUrl);
  if (!preparing) {
    preparing = prepare(databaseUrl).catch((err: unknown) => {
      if (prepared.get(databaseUrl) === preparing) prepared.delete(databaseUrl);
      throw err;
    });
    prepared.set(databaseUrl, preparing);
  }
  return preparing;
}

async function prepare(databaseUrl: string): Promise<void> {
  try {
    await DBOS.migrate(databaseUrl);
  } catch (err) {
    // The database, or a DBOS table, made by another process meanwhile: it is there.
    if (!madeAlready(err)) throw new Error(`could not prepare the database: ${errorMessage(err)}`, { cause: err });
  }
  const conn = new Client({ connectionString: databaseUrl });
  await conn.connect();
  try {
    for (const [what, ddl] of TABLES) await createTable(conn, ddl, what);
  } finally {
    await conn.end();
  }
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
