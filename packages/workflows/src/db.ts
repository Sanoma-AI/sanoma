import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { Client, escapeIdentifier, Pool } from "pg";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The runtime's own tables live in the config's database, beside DBOS's: the credentials, the
// ledger, the collections' records, the wakeup's row and the operator agent's chats. What they
// share is here: the one preparation of a database, a pool that opens once it is prepared and
// survives a dropped connection, and a table creation two processes may race.

/** A connection or a pool: what the queries take. */
export type Db = Pick<Pool | Client, "query">;

/** Where the credentials set from the app live. */
export const CREDENTIALS_TABLE = "sanoma_credentials";
/** Where the Postgres ledger keeps its records. */
export const LEDGER_TABLE = "sanoma_ledger";
/** Where the collections keep their records (`collection.ts`): one row per collection and key, the record as JSON. */
export const DATA_TABLE = "sanoma_data";
/**
 * The instance's side of its wakeup: one row, made with the table. `owner` is the worker that
 * registers, `generation` counts registrations up, `at` is the deadline registered, `stopped_at`
 * when the worker last stopped, `registered_at` when the wakeup last took one, `last_error` why
 * the last registration failed.
 */
export const WAKEUP_TABLE = "sanoma_wakeup";
/** The operator agent's chats (`chats.ts`): who each is for, its engine and its draft. */
export const CHATS_TABLE = "sanoma_chats";
/** Each chat's messages, the AI SDK's UI messages as JSON, in `seq` order. */
export const CHAT_MESSAGES_TABLE = "sanoma_chat_messages";

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
  [
    "wakeup",
    `CREATE TABLE IF NOT EXISTS ${WAKEUP_TABLE} (id integer PRIMARY KEY CHECK (id = 1), owner uuid, ` +
      "generation bigint NOT NULL DEFAULT 0, at timestamptz, stopped_at timestamptz, registered_at timestamptz, " +
      `last_error text); INSERT INTO ${WAKEUP_TABLE} (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  ],
  [
    "chats",
    `CREATE TABLE IF NOT EXISTS ${CHATS_TABLE} (id text PRIMARY KEY, person text NOT NULL, engine text NOT NULL, ` +
      "draft_id text, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); " +
      `CREATE INDEX IF NOT EXISTS ${CHATS_TABLE}_person ON ${CHATS_TABLE} (person, created_at)`,
  ],
  [
    "chat messages",
    `CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (chat_id text NOT NULL REFERENCES ${CHATS_TABLE} (id) ` +
      "ON DELETE CASCADE, id text NOT NULL, seq integer NOT NULL, message jsonb NOT NULL, PRIMARY KEY (chat_id, id))",
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
 * credentials, ledger, data, wakeup and chat tables, and its idle-transaction timeout (`guardIdleTransactions`).
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
    await DBOS.migrate(databaseUrl).catch((err: unknown) => {
      // A DBOS table made meanwhile by a release from before the lock, mid-upgrade: it is there.
      if (!madeAlready(err)) throw unprepared(err);
    });
    for (const [what, ddl] of TABLES) await createTable(conn, ddl, what);
    await guardIdleTransactions(conn);
  } finally {
    // Ending the session releases the lock; a failure to end it must not hide the preparation's.
    await conn.end().catch(() => undefined);
  }
}

/**
 * A connection to the database at `databaseUrl` (made first when missing) holding the
 * preparation's session lock until it ends, so a second process waits, then finds everything
 * made. Racing `DBOS.migrate`s lose to each other in many ways (40P01, XX000), so the race is
 * prevented rather than each loss forgiven. The lock is polled, never waited for by a blocked
 * statement: `CREATE INDEX CONCURRENTLY` waits on that statement's snapshot, a deadlock Postgres
 * cannot see (the lock's holder is this connection, not the migration's).
 */
async function lockPreparation(databaseUrl: string): Promise<Client> {
  const conn = await connectMaking(databaseUrl);
  try {
    const ask = "SELECT pg_try_advisory_lock(hashtext('sanoma.prepareDatabase')) AS locked";
    while (!(await conn.query<{ locked: boolean }>(ask)).rows[0]!.locked) await delay(50);
    return conn;
  } catch (err) {
    await conn.end().catch(() => undefined);
    throw err;
  }
}

/** A connection to the database at `databaseUrl`, made first when it is not there (`createDatabase`). */
export async function connectMaking(databaseUrl: string): Promise<Client> {
  return connect(databaseUrl).catch(async (err: unknown) => {
    if (pgCode(err) !== NO_DATABASE) throw err;
    await createDatabase(databaseUrl);
    return connect(databaseUrl);
  });
}

async function connect(databaseUrl: string): Promise<Client> {
  const conn = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  // An error nobody listens for ends the process; the query in flight fails with it.
  conn.on("error", (err) => warn(`a preparation connection failed: ${errorMessage(err)}`));
  await conn.connect();
  return conn;
}

/**
 * Makes the database at `databaseUrl` through its server's `postgres` database, as `DBOS.migrate`
 * would. Another process making it first is no failure.
 */
async function createDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = decodeURI(url.pathname.slice(1));
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

// The wakeup row's reads and writes. Every write after the claim names the owner: a worker
// another process has replaced since (a second instance on the database) changes nothing.

// `at` is the deadline registered for the row's generation, null until one is: a new generation
// (each start and each stop attempt) clears it, so a wake registered earlier is stale.

/** Makes `owner` the worker that registers the instance's wakeups; a running worker needs no wake registered before. */
export async function claimWakeup(db: Db, owner: string): Promise<void> {
  await db.query(`UPDATE ${WAKEUP_TABLE} SET owner = $1, generation = generation + 1, at = NULL WHERE id = 1`, [owner]);
}

/** Counts the row's generation up while `owner` still owns it: the new generation, or undefined when another worker owns the row now. */
export async function nextWakeupGeneration(db: Db, owner: string): Promise<number | undefined> {
  const { rows } = await db.query<{ generation: string }>(
    `UPDATE ${WAKEUP_TABLE} SET generation = generation + 1, at = NULL WHERE id = 1 AND owner = $1 RETURNING generation`,
    [owner],
  );
  return rows[0] && Number(rows[0].generation);
}

/** Records that the wakeup took `at` for `generation`. */
export async function recordWakeupRegistration(db: Db, owner: string, generation: number, at: string): Promise<void> {
  await db.query(
    `UPDATE ${WAKEUP_TABLE} SET at = $3, registered_at = now(), last_error = NULL WHERE id = 1 AND owner = $1 AND generation = $2`,
    [owner, generation, at],
  );
}

/** Records why registering `generation` failed; with none, why nothing can be registered, at the row's generation. */
export async function recordWakeupError(
  db: Db,
  owner: string,
  generation: number | undefined,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE ${WAKEUP_TABLE} SET last_error = $3 WHERE id = 1 AND owner = $1 AND ($2::bigint IS NULL OR generation = $2)`,
    [owner, generation ?? null, error],
  );
}

/** Records that the worker stops now, with `generation` registered. */
export async function recordWakeupStop(db: Db, owner: string, generation: number): Promise<void> {
  await db.query(`UPDATE ${WAKEUP_TABLE} SET stopped_at = now() WHERE id = 1 AND owner = $1 AND generation = $2`, [
    owner,
    generation,
  ]);
}

/**
 * True when `generation` is the wakeup row's and the worker stopped with it: the wake
 * `/wake?generation=N` asks for is the one the worker last registered before it stopped, not
 * one a later stop replaced, nor one registered by a worker that then kept running. For the
 * route's supervisor, which decides on its own what a wake means when no wakeup is declared.
 */
export async function shouldWake(databaseUrl: string, generation: number): Promise<boolean> {
  await prepareDatabase(databaseUrl);
  const conn = await connect(databaseUrl);
  try {
    const { rows } = await conn.query<{ current: boolean }>(
      `SELECT generation = $1 AND at IS NOT NULL AND stopped_at >= registered_at ` +
        `AS current FROM ${WAKEUP_TABLE} WHERE id = 1`,
      [generation],
    );
    return rows[0]?.current === true;
  } finally {
    await conn.end().catch(() => undefined);
  }
}
