import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { drizzle, type NodePgClient, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { type PgDatabase, PgPreparedQuery } from "drizzle-orm/pg-core";
import { Client, escapeIdentifier, Pool } from "pg";
import { inviteRequests, wakeup } from "./db/company.ts";
import { workflowStatus } from "./db/dbos.ts";
import { applyMigrations, COMPANY_MIGRATIONS, type Migrations, migrationsApplied } from "./db/migrate.ts";
import { warn } from "./log.ts";
import { errorMessage } from "./shared.ts";

// The runtime's own tables live in the config's database, beside DBOS's (`db/company.ts`). What
// the stores share is here: Drizzle over a `pg` pool or connection (`databaseOn`), the one
// preparation of a database, which applies the generated migrations under a lock, and a pool that
// opens once it is prepared and survives a dropped connection.

/**
 * A database, or a transaction on one (`db.transaction`): what every store takes, so a store runs
 * inside a caller's transaction as it runs on its own. Made by `databaseOn`.
 */
export type Db = PgDatabase<NodePgQueryResultHKT>;

/**
 * Drizzle over `client`, a `pg` pool or connection the caller owns and ends. Column names are the
 * schema's properties in snake_case (`casing`), as the generated migrations write them.
 *
 * A statement that fails throws the `pg` error itself, as `client.query` would, not Drizzle's
 * `DrizzleQueryError`, whose message carries the statement and its parameters (a credential's
 * sealed value, a person's email, a record): `pgCode` reads the code, and no message or log
 * repeats what was sent. `db.test.ts` holds Drizzle to this with a sentinel parameter.
 */
export function databaseOn(client: NodePgClient): NodePgDatabase {
  rethrowCause();
  return drizzle(client, { casing: "snake_case" });
}

let rethrowing = false;

/**
 * Makes every prepared query of this copy of Drizzle throw the driver's error in place of
 * `DrizzleQueryError` (drizzle-orm 0.45.4 wraps in `PgPreparedQuery.queryWithCache`, the one
 * place every query passes). Once per copy of the module.
 */
function rethrowCause(): void {
  if (rethrowing) return;
  rethrowing = true;
  const prototype = PgPreparedQuery.prototype as unknown as {
    queryWithCache(this: unknown, ...args: unknown[]): Promise<unknown>;
  };
  const wrapped = prototype.queryWithCache;
  prototype.queryWithCache = async function (...args) {
    try {
      return await wrapped.apply(this, args);
    } catch (err) {
      throw err instanceof DrizzleQueryError && err.cause !== undefined ? err.cause : err;
    }
  };
}

/**
 * Transitional, until every module is on the query builder: what the modules not yet rewritten
 * take, a `pg` pool or connection's `query`. Deleted with the last `query` caller.
 */
export type LegacyQuery = Pick<Pool | Client, "query">;

/**
 * Transitional: a `Db` that also answers `query` (and, over a pool, `connect`) as the `pg` pool or
 * connection under it does, so a converted module and one not yet converted share one `lazyDb`.
 */
export type LegacyDb = Db & LegacyQuery & Pick<Pool, "connect">;

/**
 * Transitional: `db` with `query` on the `pg` client under it (a transaction's connection, or the
 * pool), read from Drizzle's session (drizzle-orm 0.45.4, `NodePgSession.client`). Replaces the
 * relational query API's `db.query`, which the runtime does not use.
 */
export function withLegacyQuery<T extends Db>(db: T): T & LegacyQuery & Pick<Pool, "connect"> {
  const { client } = (db as unknown as { session: { client: Pool | Client } }).session;
  return Object.assign(db, {
    query: client.query.bind(client),
    ...(client instanceof Pool && { connect: client.connect.bind(client) }),
  }) as T & LegacyQuery & Pick<Pool, "connect">;
}

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
 * Stamps the change runs `ids` still unfinished on another version with the application version
 * `version`, so DBOS gives them to a worker of that version: those it stamped, each with its status
 * (a PENDING one is the caller's to queue again). DBOS has no call for it (a run's version is set at
 * its start, `forkWorkflow` makes a new id, `rewindWorkflow` takes only an ended run), so this is the
 * runtime's one write to DBOS's own tables (`db/dbos.ts`, dbos-sdk 5.2.11). One statement: of two
 * workers stamping a run, one does.
 */
export async function stampVersion(
  db: Db,
  ids: readonly string[],
  version: string,
): Promise<{ id: string; pending: boolean }[]> {
  const stamped = await db
    .update(workflowStatus)
    .set({ applicationVersion: version })
    .where(
      and(
        inArray(workflowStatus.workflowUuid, [...ids]),
        eq(workflowStatus.name, "change"),
        inArray(workflowStatus.status, ["PENDING", "ENQUEUED"]),
        ne(workflowStatus.applicationVersion, version),
      ),
    )
    .returning({ id: workflowStatus.workflowUuid, status: workflowStatus.status });
  return stamped.map((r) => ({ id: r.id, pending: r.status === "PENDING" }));
}

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

/** A database opened on first use, once prepared, and ended by `close`. */
export interface LazyDb {
  db(): Promise<LegacyDb>;
  close(): Promise<void>;
}

/**
 * A database for `what` on a pool at `databaseUrl`, opened on the first `db()` once the database
 * is prepared (`prepareDatabase`). A preparation that fails lets the pool go, so the next `db()`
 * tries again. `close` ends the pool, for good: a `db()` after it is refused.
 */
export function lazyDb(databaseUrl: string, what: string): LazyDb {
  let pool: Pool | undefined;
  let db: LegacyDb | undefined;
  let closed = false;
  return {
    async db() {
      if (closed) throw new Error(`the ${what} store is closed`);
      const current = (pool ??= openPool(databaseUrl, what));
      try {
        await prepareDatabase(databaseUrl);
      } catch (err) {
        if (pool === current) pool = db = undefined;
        await current.end().catch(() => undefined);
        throw err;
      }
      return (db ??= withLegacyQuery(databaseOn(current)));
    },
    async close() {
      closed = true;
      const current = pool;
      pool = db = undefined;
      await current?.end();
    },
  };
}

/** Each database prepared, or being prepared, by its URL. A failed preparation is forgotten. */
const prepared = new Map<string, Promise<void>>();

/** What prepares the databases instead of this process (`checkPreparedOnly`), which a refusal names. */
let preparedBy: string | undefined;

/**
 * From now on, `prepareDatabase` makes nothing: it only checks that DBOS's tables and the
 * runtime's are there, and refuses, naming `by`, what prepares them, when they are not. For a
 * process beside the one that prepares the database, which must never migrate it: the Cloudflare
 * host's Worker, whose container prepares it at its start.
 */
export function checkPreparedOnly(by: string): void {
  preparedBy = by;
}

/**
 * Makes the database at `databaseUrl` ready for the runtime, once per process and URL: the
 * database itself and DBOS's tables when they are not there yet (as a worker's launch makes
 * them; credentials may be set, and a ledger read, before any worker has run), then the
 * runtime's tables, by the migrations the database has not had (`COMPANY_MIGRATIONS`), and its
 * idle-transaction timeout (`guardIdleTransactions`). Two processes preparing one database both
 * succeed: the second waits for the first (`lockPreparation`). A preparation that fails is
 * forgotten, so the next call tries again.
 */
export function prepareDatabase(databaseUrl: string): Promise<void> {
  let preparing = prepared.get(databaseUrl);
  if (!preparing) {
    const made = preparedBy === undefined ? prepare(databaseUrl) : checkPrepared(databaseUrl, preparedBy);
    preparing = made.catch((err: unknown) => {
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
  await underPreparationLock(databaseUrl, async (conn) => {
    await DBOS.migrate(databaseUrl).catch((err: unknown) => {
      // A DBOS table made meanwhile by a release from before the lock, mid-upgrade: it is there.
      if (!madeAlready(err)) throw unprepared(err);
    });
    const db = databaseOn(conn);
    await applyMigrations(db, COMPANY_MIGRATIONS).catch((err: unknown) => {
      throw unprepared(err);
    });
    await guardIdleTransactions(db);
  });
}

/**
 * Runs `make` on a connection holding the preparation's session lock of the database at
 * `databaseUrl` (made first when missing), so a second process waits, then finds everything made.
 * For what makes a database's tables: `prepareDatabase`, and the wakeup service's own.
 */
export async function underPreparationLock<T>(databaseUrl: string, make: (conn: Client) => Promise<T>): Promise<T> {
  const conn = await lockPreparation(databaseUrl).catch((err: unknown) => {
    throw unprepared(err);
  });
  try {
    return await make(conn);
  } finally {
    // Ending the session releases the lock; a failure to end it must not hide the preparation's.
    await conn.end().catch(() => undefined);
  }
}

/**
 * Refuses when the database at `databaseUrl` lacks DBOS's tables or the runtime's (every
 * migration of `COMPANY_MIGRATIONS`, by its journal): `by` makes them, not this process.
 */
async function checkPrepared(databaseUrl: string, by: string): Promise<void> {
  const conn = await connect(databaseUrl);
  try {
    const db = databaseOn(conn);
    const { rows } = await db.execute<{ dbos: boolean }>(
      sql`SELECT to_regclass('dbos.workflow_status') IS NOT NULL AS dbos`,
    );
    const dbos = rows[0]?.dbos === true;
    const ours = await migrationsApplied(db, COMPANY_MIGRATIONS);
    if (!dbos || !ours) {
      const missing = [...(dbos ? [] : ["DBOS's"]), ...(ours ? [] : ["Sanoma's"])].join(" and ");
      throw new Error(`the database has no ${missing} tables yet: ${by} makes them, and this process never does`);
    }
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/**
 * A connection to the database at `databaseUrl` (made first when missing) holding the
 * preparation's session lock until it ends, so a second process waits, then finds everything
 * made. Racing `DBOS.migrate`s lose to each other in many ways (40P01, XX000), and Drizzle's
 * migrator takes no lock of its own, so the race is prevented rather than each loss forgiven.
 * The lock is polled, never waited for by a blocked statement: `CREATE INDEX CONCURRENTLY` waits
 * on that statement's snapshot, a deadlock Postgres cannot see (the lock's holder is this
 * connection, not the migration's).
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
    await db.execute(sql`DO $$ BEGIN
      IF current_setting('idle_in_transaction_session_timeout') = '0' AND NOT EXISTS (
        SELECT FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) c
        WHERE d.datname = current_database() AND s.setrole = 0 AND c LIKE 'idle_in_transaction_session_timeout=%'
      ) THEN
        EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(),
          ${sql.raw(`'${IDLE_IN_TRANSACTION_TIMEOUT}'`)});
      END IF;
    END $$`);
  } catch (err) {
    if (pgCode(err) !== INSUFFICIENT_PRIVILEGE) throw unprepared(err);
  }
}

/**
 * Makes the tables of `of` in the database at `databaseUrl` (the database too, when it is not
 * there), under the preparation's lock: for a service with tables of its own, on a database that
 * may also be a company's. Any other failure names `what`, with its cause.
 */
export async function prepareTables(databaseUrl: string, of: Migrations, what: string): Promise<void> {
  await underPreparationLock(databaseUrl, async (conn) => {
    try {
      await applyMigrations(databaseOn(conn), of);
    } catch (err) {
      throw new Error(`could not prepare the ${what} tables: ${errorMessage(err)}`, { cause: err });
    }
  });
}

export type { Migrations } from "./db/migrate.ts";
export { WAKEUP_MIGRATIONS } from "./db/migrate.ts";

// The wakeup row's writes: one worker registers per instance (the supervisor runs one at a time,
// and a deploy stops the old container before the new one starts), so none names a worker.

/** Records that the wakeup took `at`. */
export async function recordWakeupRegistration(db: Db, at: string): Promise<void> {
  await db
    .update(wakeup)
    .set({ at: new Date(at), lastError: null })
    .where(eq(wakeup.id, 1));
}

/** Records why the last registration failed. */
export async function recordWakeupError(db: Db, error: string): Promise<void> {
  await db.update(wakeup).set({ lastError: error }).where(eq(wakeup.id, 1));
}

/** Records that the worker stops itself now. */
export async function recordWakeupStop(db: Db): Promise<void> {
  await db
    .update(wakeup)
    .set({ stoppedAt: sql`now()` })
    .where(eq(wakeup.id, 1));
}

/**
 * Marks a sealed invite request's `nonce` spent until `expiresAt`, when the row goes: true the
 * first time, false for one spent already, whichever process asks. A row, not memory: the app
 * keeps nothing across requests.
 */
export async function spendInviteRequest(db: Db, nonce: string, expiresAt: Date): Promise<boolean> {
  // Rows go an hour after they expire, not at it: the app's clock decides when a request is
  // past, and a database clock ahead of it must not forget a nonce the app still accepts.
  await db.delete(inviteRequests).where(lte(inviteRequests.expiresAt, sql`now() - interval '1 hour'`));
  const spent = await db
    .insert(inviteRequests)
    .values({ nonce, expiresAt })
    .onConflictDoNothing({ target: inviteRequests.nonce })
    .returning({ nonce: inviteRequests.nonce });
  return spent.length === 1;
}

/** Whether `db`'s wakeup row says the worker ever stopped itself: for the schedules' backfill. */
export async function lastStopped(db: Db): Promise<Date | undefined> {
  const [row] = await db.select({ stoppedAt: wakeup.stoppedAt }).from(wakeup).where(eq(wakeup.id, 1));
  return row?.stoppedAt ?? undefined;
}
