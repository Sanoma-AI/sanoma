import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { setTimeout } from "node:timers/promises";
import { Client, escapeIdentifier, Pool } from "pg";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The runtime's own tables live in the config's database, beside DBOS's: the credentials, the
// ledger and the collections' records. What they share is here: the one preparation of a
// database, a pool that opens once it is prepared and survives a dropped connection, and a table
// creation two processes may race.

/** A connection or a pool: what the queries take. */
export type Db = Pick<Pool | Client, "query">;

/** Where the credentials set from the app live. */
export const CREDENTIALS_TABLE = "sanoma_credentials";
/** Where the Postgres ledger keeps its records. */
export const LEDGER_TABLE = "sanoma_ledger";
/** Where the collections keep their records (`collection.ts`): one row per collection and key, the record as JSON. */
export const DATA_TABLE = "sanoma_data";

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
  [
    "data",
    `CREATE TABLE IF NOT EXISTS ${DATA_TABLE} (collection text NOT NULL, key text NOT NULL, record jsonb NOT NULL, ` +
      "updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL, PRIMARY KEY (collection, key))",
  ],
];

/** The Postgres error code of `err`, or an empty string when it has none. */
export const pgCode = (err: unknown): string => (err as { code?: unknown } | null)?.code?.toString() ?? "";

/**
 * Postgres's codes for a database, a row type or a table another process made first. Two racing
 * `CREATE TABLE IF NOT EXISTS` both pass the check, and the loser fails on the table's row type in
 * `pg_type`: as a unique violation (23505), or as a duplicate object (42710, "type ... already
 * exists"). Two racing `CREATE DATABASE` fail as 42P04, or on `pg_database` as 23505.
 */
const MADE_ALREADY = new Set(["23505", "42P04", "42P07", "42710"]);

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

/**
 * What every DBOS handle on the config's database is given (`DBOS.setConfig`, `dbosClient`): DBOS
 * is told not to set Postgres's `idle_in_transaction_session_timeout` on each connection of its
 * pool. It sends that `SET` from the pool's `connect` event without awaiting it (dbos-sdk 5.2.11,
 * dist/src/system_database.js:691), so the pool hands the connection out while it runs: two
 * queries at once on one client, which pg deprecates. `prepareDatabase` sets the same 60 s guard
 * on the database instead. Remove the switch when DBOS awaits its `SET`.
 */
export const DBOS_DATABASE_OPTIONS = { systemDatabaseIdleTransactionTimeoutMs: 0 } as const;

/**
 * A DBOS client of the app `applicationName` on the database at `databaseUrl`, as every client of
 * the runtime, its tests and `@sanoma-ai/testing` make one (`DBOS_DATABASE_OPTIONS`).
 */
export const dbosClient = (databaseUrl: string, applicationName?: string): Promise<DBOSClient> =>
  DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    ...(applicationName !== undefined && { applicationName }),
    ...DBOS_DATABASE_OPTIONS,
  });

/**
 * The `idle_in_transaction_session_timeout` `prepareDatabase` sets: DBOS's own default
 * (`DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS`, 60_000, in dbos-sdk 5.2.11 dist/src/system_database.js),
 * how long a frozen or unreachable client may hold the system database's locks.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = "60s";

/** Postgres's code for a statement the role lacks the privilege for. */
const INSUFFICIENT_PRIVILEGE = "42501";

/** Postgres's code for a database that is not there (`invalid_catalog_name`). */
const NO_DATABASE = "3D000";

/** The advisory lock a preparation of a database holds (`lockPreparation`), in that database. */
const PREPARE_LOCK = "hashtext('sanoma.prepareDatabase')";

/** How long a preparation waits before it asks for the lock again (`lockPreparation`). */
const LOCK_POLL_MS = 50;

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
 * credentials, ledger and data tables, and its idle-transaction timeout (`guardIdleTransactions`).
 * Two processes preparing one database both succeed: the second waits for the first
 * (`lockPreparation`). A preparation that fails is forgotten, so the next call tries again.
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

/** The error a preparation fails with, its cause `err`. */
const unprepared = (err: unknown): Error =>
  new Error(`could not prepare the database: ${errorMessage(err)}`, { cause: err });

async function prepare(databaseUrl: string): Promise<void> {
  const conn = await lockPreparation(databaseUrl).catch((err: unknown) => {
    throw unprepared(err);
  });
  try {
    try {
      await DBOS.migrate(databaseUrl);
    } catch (err) {
      // A DBOS table made meanwhile by a process that does not take the lock: it is there.
      if (!madeAlready(err)) throw unprepared(err);
    }
    for (const [what, ddl] of TABLES) await createTable(conn, ddl, what);
    await guardIdleTransactions(conn);
  } finally {
    // Ending the session releases the lock.
    await conn.end();
  }
}

/**
 * A connection to the database at `databaseUrl`, made first when it is not there, that holds the
 * preparation's lock until it ends: a second process preparing the database waits for the first,
 * then finds everything made. Two processes running `DBOS.migrate` on a new database at once lose
 * to each other inside DBOS's own migrations, as a deadlock (40P01) between their `CREATE INDEX
 * CONCURRENTLY`s or as "tuple concurrently updated" (XX000), so the race is prevented rather than
 * each way of losing it forgiven. The lock is the session's (`pg_advisory_lock`'s kind), held
 * outside any transaction, and waited for by asking again (`pg_try_advisory_lock`), never by a
 * blocked statement: `CREATE INDEX CONCURRENTLY` waits for every older snapshot in its database,
 * and a statement blocked on the lock keeps one, so the migration would wait on the waiter that
 * waits on it, through a holder (this connection) Postgres cannot see is waiting on the migration.
 */
async function lockPreparation(databaseUrl: string): Promise<Client> {
  const conn = await connect(databaseUrl).catch(async (err: unknown) => {
    if (pgCode(err) !== NO_DATABASE) throw err;
    await createDatabase(databaseUrl);
    return connect(databaseUrl);
  });
  try {
    const ask = `SELECT pg_try_advisory_lock(${PREPARE_LOCK}) AS locked`;
    while (!(await conn.query<{ locked: boolean }>(ask)).rows[0]!.locked) await setTimeout(LOCK_POLL_MS);
    return conn;
  } catch (err) {
    await conn.end().catch(() => undefined);
    throw err;
  }
}

async function connect(databaseUrl: string): Promise<Client> {
  const conn = new Client({ connectionString: databaseUrl });
  await conn.connect();
  return conn;
}

/**
 * Makes the database at `databaseUrl` through its server's `postgres` database, as `DBOS.migrate`
 * would. Another process making it first is no failure.
 */
async function createDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres";
  const admin = await connect(url.toString());
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  } catch (err) {
    if (!madeAlready(err)) throw err;
  } finally {
    await admin.end();
  }
}

/**
 * Sets `idle_in_transaction_session_timeout` on the database, for each session that starts after,
 * as DBOS would per connection (`DBOS_DATABASE_OPTIONS`), unless the server, the role or the
 * database sets it already. `db` holds the preparation's lock, so one process at a time. A role
 * that may not alter the database leaves it, quietly: its administrator decides.
 */
async function guardIdleTransactions(db: Db): Promise<void> {
  try {
    await db.query(`DO $$ BEGIN
      IF current_setting('idle_in_transaction_session_timeout') = '0' AND NOT EXISTS (
        SELECT FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) c
        WHERE d.datname = current_database() AND s.setrole = 0 AND c LIKE 'idle_in_transaction_session_timeout=%'
      ) THEN
        EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(),
          '${IDLE_IN_TRANSACTION_TIMEOUT}');
      END IF;
    END $$`);
  } catch (err) {
    if (pgCode(err) !== INSUFFICIENT_PRIVILEGE) throw unprepared(err);
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
