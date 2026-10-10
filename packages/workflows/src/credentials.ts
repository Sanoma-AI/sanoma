import { setTimeout as sleep } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Client, type Pool } from "pg";
import { credentialsOf } from "./config.ts";
import { info, warn } from "./log.ts";
import type { Driver } from "./op.ts";
import { errorMessage } from "./shared.ts";

// Where the credentials set from the app live: one table in the config's database, beside DBOS's
// own. A value is read here only, by the worker to load it into its environment and by the
// client to check it, and leaves neither. The write (`storeCredential`) and the read
// (`storedCredentials`) are the only places that touch `value`, so a hosted deployment's
// encryption goes there.

const TABLE = "sanoma_credentials";
/** Where a change is announced, with the variable's name as the payload. */
const CHANNEL = "sanoma_credentials";

type Db = Pick<Pool | Client, "query">;

/** Postgres's codes for a row type or a table another process made first. */
const MADE_ALREADY = new Set(["23505", "42P07"]);

/**
 * Creates the config's database and DBOS's tables when they are not there yet, as a worker's
 * launch does (credentials may be set before any worker has run), then the credentials table
 * on the connection `connected` gives. Two processes racing to create it both succeed.
 */
export async function ensureTable(databaseUrl: string, connected: () => Promise<Db>): Promise<void> {
  try {
    await DBOS.migrate(databaseUrl);
    await (
      await connected()
    ).query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, value text NOT NULL, ` +
        "set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())",
    );
  } catch (err) {
    if (MADE_ALREADY.has((err as { code?: string }).code ?? "")) return;
    throw new Error(`could not prepare the credentials table: ${errorMessage(err)}`, { cause: err });
  }
}

/** The stored rows of these names, values included: for loading into an environment or checking, never for showing. */
export async function storedCredentials(
  db: Db,
  names: readonly string[],
): Promise<Map<string, { value: string; setBy: string; setAt: string }>> {
  const { rows } = await db.query<{ name: string; value: string; set_by: string; set_at: Date }>(
    `SELECT name, value, set_by, set_at FROM ${TABLE} WHERE name = ANY($1)`,
    [names],
  );
  return new Map(rows.map((r) => [r.name, { value: r.value, setBy: r.set_by, setAt: r.set_at.toISOString() }]));
}

/** Upserts the value and announces it, in one statement, so a worker never hears of a change it cannot read. */
export async function storeCredential(
  db: Db,
  { name, value, setBy }: { name: string; value: string; setBy: string },
): Promise<void> {
  await db.query(
    `WITH stored AS (INSERT INTO ${TABLE} (name, value, set_by) VALUES ($1, $2, $3) ` +
      "ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = now() " +
      `RETURNING name) SELECT pg_notify('${CHANNEL}', name) FROM stored`,
    [name, value, setBy],
  );
}

/** Deletes the row, announcing it when there was one. */
export async function deleteCredential(db: Db, name: string): Promise<void> {
  await db.query(
    `WITH gone AS (DELETE FROM ${TABLE} WHERE name = $1 RETURNING name) SELECT pg_notify('${CHANNEL}', name) FROM gone`,
    [name],
  );
}

/** Stops a worker's credentials listener. */
export interface CredentialsWatch {
  close(): Promise<void>;
}

/** The longest wait between two attempts to reconnect the listener, and between two warnings that one failed. */
const RETRY_MAX_MS = 30_000;

/**
 * Loads the stored values of the declared variables the environment does not set into
 * `process.env`, then keeps them current: on each change announced, and on reconnecting, it
 * loads them again, so a value set replaces the one before and a value cleared is deleted. A
 * name the environment set when this started is never touched, and the names it did set are
 * deleted on `close`. Logs, per vendor, how many variables each load changed, never a value, and
 * warns of a reloaded value its schema refuses. A listener that drops reconnects, waiting longer
 * after each failure, up to 30 s, until it is closed. With no such variable, it connects to nothing.
 */
export async function watchCredentials(databaseUrl: string, drivers: readonly Driver[]): Promise<CredentialsWatch> {
  const vendors = new Map<string, string>();
  for (const [vendor, list] of credentialsOf(drivers, () => undefined)) {
    for (const { name } of list) if (!process.env[name] && !vendors.has(name)) vendors.set(name, vendor);
  }
  const names = [...vendors.keys()];
  if (!names.length) return { close: async () => undefined };
  /** The listener's connection, from when it connects until it drops or closes. */
  let db: Client | undefined;
  let closed = false;
  let reconnecting = false;
  // One load at a time, so close() can wait for it; the changes announced during one make one more.
  let loading: Promise<void> | undefined;
  let stale = false;

  async function load(first: boolean) {
    const conn = db;
    if (closed || !conn) return;
    const rows = await storedCredentials(conn, names);
    // Nothing touches the environment once closed: a worker or an app started after may own it.
    if (closed) return;
    const changed = names.filter((name) => rows.get(name)?.value !== process.env[name]);
    const counts = new Map<string, number>();
    for (const name of changed) {
      const value = rows.get(name)?.value;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      const vendor = vendors.get(name)!;
      counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
    }
    const verb = first ? "loaded" : "reloaded";
    for (const [vendor, n] of counts) info(`credentials ${verb} for ${vendor} (${n} variable${n === 1 ? "" : "s"})`);
    // At start, startWorker refuses an invalid one, naming it.
    if (first) return;
    for (const list of credentialsOf(drivers, (name) =>
      changed.includes(name) ? process.env[name] : undefined,
    ).values()) {
      for (const c of list) {
        if (c.status === "invalid")
          warn(`the stored ${c.name} is invalid (${c.problem}): calls that read it will fail`);
      }
    }
  }

  function reload(first = false): Promise<void> {
    if (loading) {
      stale = true;
      return loading;
    }
    loading = (async () => {
      try {
        do {
          stale = false;
          await load(first);
          first = false;
        } while (stale);
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  async function open(first: boolean) {
    const conn = new Client({ connectionString: databaseUrl, keepAlive: true, connectionTimeoutMillis: 10_000 });
    // Before anything can fail: an error nobody listens for ends the process.
    conn.on("error", (err) => lost(conn, err));
    // Before LISTEN, so no change announced from then on is missed.
    conn.on("notification", () => {
      if (!closed && conn === db) {
        reload().catch((err: unknown) => warn(`could not reload the credentials: ${errorMessage(err)}`));
      }
    });
    try {
      if (first) await ensureTable(databaseUrl, () => conn.connect().then(() => conn));
      else await conn.connect();
      if (closed) {
        await conn.end();
        return;
      }
      db = conn;
      await conn.query(`LISTEN ${CHANNEL}`);
      await reload(first);
    } catch (err) {
      if (db === conn) db = undefined;
      await conn.end().catch(() => undefined);
      throw err;
    }
  }

  /** A connection that dropped: the one listening is replaced; one still connecting fails its own open. */
  function lost(conn: Client, err: unknown) {
    if (closed || conn !== db) return;
    db = undefined;
    void conn.end().catch(() => undefined);
    warn(`the credentials listener failed (${errorMessage(err)}); reconnecting`);
    void reconnect();
  }

  async function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    let wait = 1_000;
    let warnedAt = 0;
    try {
      for (;;) {
        await sleep(wait, undefined, { ref: false });
        if (closed) return;
        try {
          await open(false);
          return;
        } catch (err) {
          if (Date.now() - warnedAt >= RETRY_MAX_MS) {
            warnedAt = Date.now();
            warn(`could not reconnect the credentials listener (${errorMessage(err)}); trying again`);
          }
          wait = Math.min(wait * 2, RETRY_MAX_MS);
        }
      }
    } finally {
      reconnecting = false;
    }
  }

  try {
    await open(true);
  } catch (err) {
    closed = true;
    throw err;
  }
  return {
    async close() {
      closed = true;
      await loading?.catch(() => undefined);
      for (const name of names) delete process.env[name];
      const conn = db;
      db = undefined;
      await conn?.end();
    },
  };
}
