import { Client, type Pool } from "pg";
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

/** A stored credential as the runtime reports it: who set it and when, never its value. */
export interface StoredCredential {
  name: string;
  vendor: string;
  setBy: string;
  /** ISO 8601. */
  setAt: string;
}

type Db = Pick<Pool | Client, "query">;

const CREATE_TABLE =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (name text PRIMARY KEY, vendor text NOT NULL, value text NOT NULL, ` +
  "set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())";

/** Postgres's code for a database that is not there. */
const NO_DATABASE = "3D000";
/** Its codes for a row type, a database or a table another process made first. */
const MADE_ALREADY = new Set(["23505", "42P04", "42P07"]);

/**
 * Creates the table, and first the config's database when it is not there yet, as DBOS does
 * when it launches: credentials may be set before any worker has run. Two processes racing to
 * create either both succeed.
 */
export async function ensureTable(databaseUrl: string): Promise<void> {
  try {
    await runOnce(databaseUrl, CREATE_TABLE);
  } catch (err) {
    if ((err as { code?: unknown }).code !== NO_DATABASE) throw err;
    // Through the server's own `postgres` database, as DBOS does.
    const admin = new URL(databaseUrl);
    const name = decodeURI(admin.pathname.slice(1));
    admin.pathname = "/postgres";
    await runOnce(admin.toString(), `CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    await runOnce(databaseUrl, CREATE_TABLE);
  }
}

/** Runs one statement on a connection of its own; one whose object another process made first succeeds. */
async function runOnce(url: string, sql: string): Promise<void> {
  const db = new Client({ connectionString: url });
  try {
    await db.connect();
    await db.query(sql);
  } catch (err) {
    if (!MADE_ALREADY.has((err as { code?: string }).code ?? "")) throw err;
  } finally {
    await db.end().catch(() => undefined);
  }
}

/** The stored rows of these names, values included: for loading into an environment or checking, never for showing. */
export async function storedCredentials(
  db: Db,
  names: readonly string[],
): Promise<Map<string, StoredCredential & { value: string }>> {
  const { rows } = await db.query<{ name: string; vendor: string; value: string; set_by: string; set_at: Date }>(
    `SELECT name, vendor, value, set_by, set_at FROM ${TABLE} WHERE name = ANY($1)`,
    [names],
  );
  return new Map(
    rows.map((r) => [
      r.name,
      { name: r.name, vendor: r.vendor, value: r.value, setBy: r.set_by, setAt: r.set_at.toISOString() },
    ]),
  );
}

/** Upserts the value and announces it, in one statement, so a worker never hears of a change it cannot read. */
export async function storeCredential(
  db: Db,
  { name, vendor, value, setBy }: Omit<StoredCredential, "setAt"> & { value: string },
): Promise<void> {
  await db.query(
    `WITH stored AS (INSERT INTO ${TABLE} (name, vendor, value, set_by) VALUES ($1, $2, $3, $4) ` +
      "ON CONFLICT (name) DO UPDATE SET vendor = EXCLUDED.vendor, value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = now() " +
      `RETURNING name) SELECT pg_notify('${CHANNEL}', name) FROM stored`,
    [name, vendor, value, setBy],
  );
}

/** Deletes the row, announcing it when there was one. */
export async function deleteCredential(db: Db, name: string): Promise<void> {
  await db.query(
    `WITH gone AS (DELETE FROM ${TABLE} WHERE name = $1 RETURNING name) SELECT pg_notify('${CHANNEL}', name) FROM gone`,
    [name],
  );
}

/** Each variable the drivers' `env` declares, with the vendor of the first driver that declares it. */
export function declared(drivers: readonly Driver[]): Map<string, string> {
  const vendors = new Map<string, string>();
  for (const { vendor, env } of drivers) {
    for (const name of Object.keys(env?.shape ?? {})) if (!vendors.has(name)) vendors.set(name, vendor);
  }
  return vendors;
}

/** Stops a worker's credentials listener. */
export interface CredentialsWatch {
  close(): Promise<void>;
}

/**
 * Loads the stored values of the declared variables the environment does not set into
 * `process.env`, then keeps them current: on each change announced, and on reconnecting, it
 * loads them again, so a value set replaces the one before and a value cleared is deleted. A
 * name the environment set when this started is never touched. Logs, per vendor, how many
 * variables each load changed, never a value. A listener that fails is reconnected once, a
 * second later; one that cannot be leaves the values as they are until the worker restarts.
 */
export async function watchCredentials(databaseUrl: string, drivers: readonly Driver[]): Promise<CredentialsWatch> {
  const vendors = declared(drivers);
  const names = [...vendors.keys()].filter((name) => !process.env[name]);
  let current: Client | undefined;
  let closed = false;
  // One load at a time: a client runs one query at a time, and notifications come as they come.
  let loading = Promise.resolve();

  async function load(db: Client, verb: string) {
    const rows = await storedCredentials(db, names);
    const changed = new Map<string, number>();
    for (const name of names) {
      const value = rows.get(name)?.value;
      if (value === process.env[name]) continue;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      const vendor = vendors.get(name)!;
      changed.set(vendor, (changed.get(vendor) ?? 0) + 1);
    }
    for (const [vendor, n] of changed) info(`credentials ${verb} for ${vendor} (${n} variable${n === 1 ? "" : "s"})`);
  }

  async function connect(verb: string) {
    await ensureTable(databaseUrl);
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      // Listening before loading, so no change falls between the two.
      await db.query(`LISTEN ${CHANNEL}`);
      await load(db, verb);
    } catch (err) {
      await db.end().catch(() => undefined);
      throw err;
    }
    db.on("notification", () => {
      loading = loading
        .then(() => load(db, "reloaded"))
        .catch((err: unknown) => warn(`could not reload the credentials: ${errorMessage(err)}`));
    });
    db.on("error", (err) => lost(db, err));
    // Closed while connecting: nobody would end it.
    if (closed) await db.end();
    else current = db;
  }

  function lost(db: Client, err: unknown) {
    if (closed || db !== current) return;
    current = undefined;
    void db.end().catch(() => undefined);
    warn(`the credentials listener failed (${errorMessage(err)}); reconnecting`);
    setTimeout(() => {
      if (closed) return;
      connect("reloaded").catch((again: unknown) =>
        warn(
          `could not reconnect the credentials listener (${errorMessage(again)}): ` +
            "a credential set or cleared from now on applies when the worker restarts",
        ),
      );
    }, 1_000).unref();
  }

  await connect("loaded");
  return {
    async close() {
      closed = true;
      await loading;
      await current?.end();
      current = undefined;
    },
  };
}
