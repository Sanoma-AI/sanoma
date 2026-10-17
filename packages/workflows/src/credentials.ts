import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { credentialsOf } from "./env.ts";
import { CREDENTIALS_TABLE as TABLE, type Db, prepareDatabase } from "./db.ts";
import { info, warn } from "./log.ts";
import type { Driver } from "./op.ts";
import type { Secrets } from "./secret.ts";
import { errorMessage } from "./shared.ts";

// Where the credentials set from the app live: one table in the config's database, beside DBOS's
// own (made by `prepareDatabase` in db.ts). A value is read here only, by the worker to load it
// into its environment or hand it to a driver (`storedSecrets`) and by the client to check it,
// and leaves none of them. The write (`storeCredential`, `ensureCredential`) and the read
// (`storedCredentials`) are the only places that touch `value`, which holds it encrypted
// (`encrypt`) under `SANOMA_SECRETS_KEY`.

/** Where a change is announced, with the variable's name as the payload. */
const CHANNEL = "sanoma_credentials";

/** The variable holding the key the stored values are encrypted with: 32 bytes, base64. */
export const SECRETS_KEY = "SANOMA_SECRETS_KEY";

/** What starts an encrypted value; a value without it is a plaintext one stored before encryption, read as it is. */
const V1 = "v1:";
const CIPHER = "aes-256-gcm";
const TAG_BYTES = 16;

/** The key from the environment, or an error naming the variable. */
function secretsKey(): Buffer {
  const text = process.env[SECRETS_KEY];
  if (!text) {
    throw new Error(
      `${SECRETS_KEY} is not set: it encrypts the stored credentials; set it to 32 random bytes, base64 (\`openssl rand -base64 32\`)`,
    );
  }
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error(`${SECRETS_KEY} must be 32 bytes, base64; it is ${key.length} bytes`);
  return key;
}

/** `value` encrypted for the table: `v1:<iv, base64>:<ciphertext and tag, base64>`, AES-256-GCM. */
export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, secretsKey(), iv);
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${V1}${iv.toString("base64")}:${sealed.toString("base64")}`;
}

/** The value `name`'s row holds: decrypted, or a plaintext one as it is (it is encrypted on its next write). */
export function decrypt(name: string, stored: string): string {
  if (!stored.startsWith(V1)) return stored;
  const [iv = "", body = ""] = stored.slice(V1.length).split(":");
  const sealed = Buffer.from(body, "base64");
  const decipher = createDecipheriv(CIPHER, secretsKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(sealed.subarray(-TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, -TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error(`the stored ${name} cannot be decrypted: ${SECRETS_KEY} is not the key it was stored with`, {
      cause: err,
    });
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
  return new Map(
    rows.map((r) => [r.name, { value: decrypt(r.name, r.value), setBy: r.set_by, setAt: r.set_at.toISOString() }]),
  );
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
    [name, encrypt(value), setBy],
  );
}

/**
 * The stored value of `name`; when there is none, `make()`'s, stored first and announced. Of two
 * at once, the first stored wins, and both return it.
 */
export async function ensureCredential(
  db: Db,
  { name, make, setBy }: { name: string; make: () => string; setBy: string },
): Promise<string> {
  const stored = (await storedCredentials(db, [name])).get(name);
  if (stored) return stored.value;
  await db.query(
    `WITH stored AS (INSERT INTO ${TABLE} (name, value, set_by) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING ` +
      `RETURNING name) SELECT pg_notify('${CHANNEL}', name) FROM stored`,
    [name, encrypt(make()), setBy],
  );
  return (await storedCredentials(db, [name])).get(name)!.value;
}

/**
 * The secrets store a live driver is given (`CallContext.secrets`): a variable the environment
 * sets wins, as it does for a driver's `env`; else the stored value. `ensure` stores what it
 * makes as `setBy`.
 */
export function storedSecrets(db: () => Promise<Db>, setBy: string): Secrets {
  return {
    get: async (name) => process.env[name] || (await storedCredentials(await db(), [name])).get(name)?.value,
    ensure: async (name, make) => process.env[name] || ensureCredential(await db(), { name, make, setBy }),
  };
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
export async function watchCredentials(
  databaseUrl: string,
  drivers: ReadonlyMap<string, Driver>,
): Promise<CredentialsWatch> {
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
    // At start, startWorker warns of an invalid one, naming it.
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
      if (first) await prepareDatabase(databaseUrl);
      await conn.connect();
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
