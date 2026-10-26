import { createHash, randomUUID } from "node:crypto";
import { connectMaking, createTable, type Db, openPool } from "./db.ts";
import { info, warn } from "./log.ts";
import { generateSecret } from "./secret.ts";
import { errorMessage } from "./shared.ts";

/*
 * `@sanoma-ai/workflows/wakeup-service`: the service that wakes stopped instances, server-side
 * only. An account (minted by whoever runs the service) registers an instance by its URL and gets
 * the instance's token; the instance, before it stops, `PUT`s when it wants waking and a
 * generation; the service then calls `GET {url}/wake?generation=N`, retrying until an answer is a
 * 2xx. It makes its two tables itself, in the database it is given (sanoma-ops's own, when it
 * hosts it): never among `db.ts`'s, which every company's database gets.
 */

/** Where the accounts live: one per party that registers instances, its token's hash alone. */
export const WAKEUP_ACCOUNTS_TABLE = "sanoma_wakeup_accounts";
/** Where the instances live: each one's URL, its token's hash and its registered wake. */
export const WAKEUP_INSTANCES_TABLE = "sanoma_wakeup_instances";

const TABLES: readonly [what: string, ddl: string][] = [
  [
    "wakeup accounts",
    `CREATE TABLE IF NOT EXISTS ${WAKEUP_ACCOUNTS_TABLE} (id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, ` +
      "label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz)",
  ],
  [
    "wakeup instances",
    `CREATE TABLE IF NOT EXISTS ${WAKEUP_INSTANCES_TABLE} (id uuid PRIMARY KEY, ` +
      `account_id uuid NOT NULL REFERENCES ${WAKEUP_ACCOUNTS_TABLE} (id), url text NOT NULL, ` +
      "token_hash text UNIQUE NOT NULL, at timestamptz, generation bigint NOT NULL DEFAULT 0, " +
      "called_at timestamptz, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, " +
      "last_error text, created_at timestamptz NOT NULL DEFAULT now())",
  ],
  // Each on its own, so one another process made first does not skip the next.
  [
    "wakeup instances",
    `CREATE INDEX IF NOT EXISTS ${WAKEUP_INSTANCES_TABLE}_at ON ${WAKEUP_INSTANCES_TABLE} (at) WHERE at IS NOT NULL`,
  ],
  [
    "wakeup instances",
    `CREATE INDEX IF NOT EXISTS ${WAKEUP_INSTANCES_TABLE}_account ON ${WAKEUP_INSTANCES_TABLE} (account_id)`,
  ],
];

/** How long a call to an instance's `/wake` may take. */
const CALL_TIMEOUT_MS = 10_000;
/** The longest the loop sleeps without looking again, whatever is due. */
const MAX_SLEEP_MS = 60_000;
/** How many instances are called at once. */
const CONCURRENCY = 8;
/** The longest wait between two tries of a failing instance, in seconds. */
const MAX_BACKOFF_S = 300;
/**
 * How long a row taken for a call is the taker's: longer than a call may take. Two services on one
 * database never call one row at once, and a call no outcome was recorded for (the process
 * stopped, or the write failed) is tried again once it lapses.
 */
const CLAIM_S = 30;
/** How many due rows a round takes: few enough to be called well within their claim. */
const ROUND_ROWS = CONCURRENCY * 2;
/** The most a request's body may hold: a registration is a few hundred bytes. */
const MAX_BODY = 64 * 1024;

/** The shape of `@sanoma-ai/app`'s `IngressRoute`, which `startApp`'s `ingress` takes. */
export interface WakeupRoute {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** `/wakeup`, with every path under it (`prefix`). */
  path: string;
  prefix: true;
  handle(request: Request): Promise<Response>;
}

export interface WakeupServiceOptions {
  /** The service's own Postgres: its tables are made there when missing (the database too). */
  databaseUrl: string;
  /** The clock: what is due, and what `called_at` and `next_attempt_at` are set from. */
  now?: () => Date;
  /** How the instances are called. */
  fetch?: typeof globalThis.fetch;
  /** One `info` line per call, a `warn` per failure; the runtime's logger by default. */
  log?: { info(line: string): void; warn(line: string): void };
}

export interface WakeupService {
  /** One route answering everything under `/wakeup`, for `startApp`'s `ingress` or a server of its own. */
  routes: WakeupRoute[];
  /** An account that may register instances: its id, and its token, shown this once. */
  mintAccount(label: string): Promise<{ id: string; token: string }>;
  /** Refuses the account's token and its instances' from now on, and wakes its instances no more. */
  revokeAccount(id: string): Promise<void>;
  /** Ends the loop, abandoning the calls in flight (called again once their claim lapses), and closes the pool. */
  stop(): Promise<void>;
}

/** A new token: the prefix, then 32 random bytes in base64url. */
const newToken = (prefix: "swa_" | "swi_") => `${prefix}${generateSecret()}`;

/**
 * The token's sha256, which is all the tables keep: a token is found by its hash (a unique index),
 * so the secret itself is never compared, and a guess's timing says nothing an attacker can steer.
 */
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A date-time as `Date.toISOString` writes one, or with an offset: four-digit years only. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS });
const problem = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...HEADERS, ...headers } });
/** 405, naming the methods the path answers. */
const notAllowed = (allow: string) => problem(405, `this path answers ${allow} only`, { allow });
const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** The request's bearer token, or undefined without one. */
function bearer(request: Request): string | undefined {
  const match = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/** The request's body as text, or undefined once it holds more than `MAX_BODY` bytes. */
async function bodyText(request: Request): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The request's JSON object, undefined when its body is not one, or a 413 for one too large. */
async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined | Response> {
  const text = await bodyText(request);
  if (text === undefined) return problem(413, "the body is too large");
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An instance's URL as it is stored, without a trailing slash, or why it is refused: `http(s)`, no
 * user or password, no query, no fragment (`/wake?generation=N` is added to it).
 */
export function instanceUrl(value: unknown): { url: string } | { error: string } {
  const refused = { error: "url must be an http(s) URL with no user, password, query or fragment" };
  if (typeof value !== "string" || /[?#]/.test(value) || !URL.canParse(value)) return refused;
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return refused;
  return { url: url.href.replace(/\/+$/, "") };
}

interface InstanceRow {
  id: string;
  account_id: string;
  url: string;
  at: Date | null;
  generation: string;
  called_at: Date | null;
  attempts: number;
  last_error: string | null;
}

/** An instance as `GET` shows it to its account. */
const shownInstance = (row: InstanceRow) => ({
  id: row.id,
  url: row.url,
  at: row.at?.toISOString() ?? null,
  generation: Number(row.generation),
  calledAt: row.called_at?.toISOString() ?? null,
  attempts: row.attempts,
  lastError: row.last_error,
});

/** A row waiting for its call: registered, not called since its `at`. */
const WAITING = "i.at IS NOT NULL AND (i.called_at IS NULL OR i.called_at < i.at)";
/** Of an account not revoked. */
const LIVE = `JOIN ${WAKEUP_ACCOUNTS_TABLE} a ON a.id = i.account_id AND a.revoked_at IS NULL`;

/**
 * Runs `use` on a connection to `databaseUrl` once the service's two tables are there: the
 * database and the tables made when missing.
 */
async function withTables<T>(databaseUrl: string, use: (db: Db) => Promise<T>): Promise<T> {
  const conn = await connectMaking(databaseUrl);
  try {
    for (const [what, ddl] of TABLES) await createTable(conn, ddl, what);
    return await use(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function insertAccount(db: Db, label: string): Promise<{ id: string; token: string }> {
  if (!label.trim()) throw new Error("An account's label must not be empty");
  const id = randomUUID();
  const token = newToken("swa_");
  await db.query(`INSERT INTO ${WAKEUP_ACCOUNTS_TABLE} (id, token_hash, label) VALUES ($1, $2, $3)`, [
    id,
    hashOf(token),
    label,
  ]);
  return { id, token };
}

/**
 * An account of the wakeup service on `databaseUrl`, minted without starting the service (its
 * tables made when missing): what `sanoma wakeup account <label>` prints.
 */
export async function mintWakeupAccount(databaseUrl: string, label: string): Promise<{ id: string; token: string }> {
  return withTables(databaseUrl, (db) => insertAccount(db, label));
}

/**
 * Starts the wakeup service on its own database: its two tables made when missing, its one loop
 * running, and `routes` for whoever serves it (`sanoma wakeup`, or `sanoma serve` with
 * `wakeup: true`). Routes, each JSON and `no-store`:
 *
 * - `POST /wakeup/instances { url }`, an account's token → 201 `{ id, token }`
 * - `GET /wakeup/instances/{id}`, its account's token → `{ id, url, at, generation, calledAt, attempts, lastError }`
 * - `DELETE /wakeup/instances/{id}`, its account's token → 204
 * - `PUT /wakeup/instances/{id}/wake { at, generation }`, the instance's own token → 204, applied
 *   only when `generation` is newer than the one it has, and waking the loop
 *
 * 401 without a token or with an unknown one, 403 for another account's or instance's, 400 for a
 * bad body, 404 for an unknown id or path.
 */
export async function startWakeupService({
  databaseUrl,
  now = () => new Date(),
  fetch = globalThis.fetch,
  log = { info, warn },
}: WakeupServiceOptions): Promise<WakeupService> {
  await withTables(databaseUrl, async () => {});
  const pool = openPool(databaseUrl, "wakeup service");
  const loop = startLoop({ pool, now, fetch, log });

  /** The live account the request's token is, or a 401. */
  async function account(request: Request): Promise<string | Response> {
    const token = bearer(request);
    if (!token?.startsWith("swa_")) return problem(401, "an account's token is needed");
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM ${WAKEUP_ACCOUNTS_TABLE} WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashOf(token)],
    );
    return rows[0]?.id ?? problem(401, "the token is no account's");
  }

  /** The account's instance `id`, or a 404, or a 403 when it is another account's. */
  async function owned(accountId: string, id: string): Promise<InstanceRow | Response> {
    if (!UUID.test(id)) return problem(404, "no such instance");
    const { rows } = await pool.query<InstanceRow>(`SELECT * FROM ${WAKEUP_INSTANCES_TABLE} WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return problem(404, "no such instance");
    return row.account_id === accountId ? row : problem(403, "the instance is another account's");
  }

  async function register(request: Request): Promise<Response> {
    const accountId = await account(request);
    if (accountId instanceof Response) return accountId;
    const given = await jsonBody(request);
    if (given instanceof Response) return given;
    const checked = instanceUrl(given?.url);
    if ("error" in checked) return problem(400, checked.error);
    const id = randomUUID();
    const token = newToken("swi_");
    await pool.query(
      `INSERT INTO ${WAKEUP_INSTANCES_TABLE} (id, account_id, url, token_hash) VALUES ($1, $2, $3, $4)`,
      [id, accountId, checked.url, hashOf(token)],
    );
    return json(201, { id, token });
  }

  async function wake(request: Request, id: string): Promise<Response> {
    const token = bearer(request);
    if (!token?.startsWith("swi_")) return problem(401, "an instance's token is needed");
    const { rows } = await pool.query<{ id: string }>(
      `SELECT i.id FROM ${WAKEUP_INSTANCES_TABLE} i ${LIVE} WHERE i.token_hash = $1`,
      [hashOf(token)],
    );
    if (!rows[0]) return problem(401, "the token is no instance's");
    if (rows[0].id !== id) return problem(403, "the token is another instance's");
    const given = await jsonBody(request);
    if (given instanceof Response) return given;
    const at = given?.at;
    const generation = given?.generation;
    if (typeof at !== "string" || !ISO_DATE_TIME.test(at) || Number.isNaN(Date.parse(at)))
      return problem(400, "at must be an ISO 8601 date-time");
    // A new instance has generation 0, so a registration counts from 1.
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
      return problem(400, "generation must be an integer, 1 or more");
    // An older or equal generation changes nothing: callers retry, at least once each.
    await pool.query(
      `UPDATE ${WAKEUP_INSTANCES_TABLE} SET at = $2, generation = $3, called_at = NULL, attempts = 0, ` +
        "next_attempt_at = NULL, last_error = NULL WHERE id = $1 AND generation < $3",
      [id, new Date(at), generation],
    );
    loop.poke();
    return noContent();
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (path === "/wakeup/instances") {
      return method === "POST" ? register(request) : notAllowed("POST");
    }
    const match = /^\/wakeup\/instances\/([^/]+)(\/wake)?$/.exec(path);
    if (!match) return problem(404, "no such route");
    const id = match[1]!;
    if (match[2]) {
      // Its token says which instance it is: another id is a 403, whatever it is.
      return method === "PUT" ? wake(request, id) : notAllowed("PUT");
    }
    if (method !== "GET" && method !== "DELETE") return notAllowed("GET, DELETE");
    const accountId = await account(request);
    if (accountId instanceof Response) return accountId;
    const row = await owned(accountId, id);
    if (row instanceof Response) return row;
    if (method === "GET") return json(200, shownInstance(row));
    await pool.query(`DELETE FROM ${WAKEUP_INSTANCES_TABLE} WHERE id = $1`, [id]);
    return noContent();
  }

  return {
    routes: [{ path: "/wakeup", prefix: true, handle }],
    mintAccount: (label) => insertAccount(pool, label),
    async revokeAccount(id) {
      if (!UUID.test(id)) return;
      await pool.query(`UPDATE ${WAKEUP_ACCOUNTS_TABLE} SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
        id,
        now(),
      ]);
    },
    async stop() {
      await loop.stop();
      await pool.end();
    },
  };
}

interface Due {
  id: string;
  url: string;
  generation: string;
}

/**
 * The one loop: calls every row that is due, at most `CONCURRENCY` at once, then sleeps until the
 * next is (at most `MAX_SLEEP_MS`) or until `poke`. A failed call is tried again after
 * `min(2^attempts s, MAX_BACKOFF_S)`, for as long as it takes: no row is ever dropped.
 */
function startLoop({
  pool,
  now,
  fetch,
  log,
}: {
  pool: ReturnType<typeof openPool>;
  now: () => Date;
  fetch: typeof globalThis.fetch;
  log: { info(line: string): void; warn(line: string): void };
}) {
  const stopping = new AbortController();
  let poked = false;
  let wakeUp: (() => void) | undefined;

  /** Calls `row`'s instance once, and records how it went, unless the registration changed meanwhile. */
  async function call(row: Due) {
    const target = `${row.url}/wake?generation=${row.generation}`;
    let error: string | undefined;
    try {
      const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
      // A redirect is no answer: it could send the service anywhere, so it is tried again as a failure.
      const res = await fetch(target, { signal, redirect: "manual" });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) error = `answered ${res.status}`;
    } catch (err) {
      error = errorMessage(err);
    }
    // Stopped mid-call: nothing is known of it, so it is called again once its claim lapses.
    if (stopping.signal.aborted) return;
    if (error === undefined) {
      await pool.query(
        `UPDATE ${WAKEUP_INSTANCES_TABLE} SET called_at = $3, attempts = 0, next_attempt_at = NULL, ` +
          "last_error = NULL WHERE id = $1 AND generation = $2",
        [row.id, row.generation, now()],
      );
      log.info(`wakeup: called ${target}`);
    } else {
      await pool.query(
        `UPDATE ${WAKEUP_INSTANCES_TABLE} SET attempts = attempts + 1, last_error = $3, ` +
          `next_attempt_at = $4::timestamptz + least(power(2, attempts), ${MAX_BACKOFF_S}) * interval '1 second' ` +
          "WHERE id = $1 AND generation = $2",
        [row.id, row.generation, error, now()],
      );
      log.warn(`wakeup: calling ${target} failed (${error}); it is tried again`);
    }
  }

  /** Calls every due row; returns when the next one is due, or undefined with none waiting. */
  async function round(): Promise<Date | undefined> {
    // Taken for `CLAIM_S`, rows another service holds skipped: each due row is called by one service.
    const { rows } = await pool.query<Due>(
      `UPDATE ${WAKEUP_INSTANCES_TABLE} SET next_attempt_at = $1::timestamptz + interval '${CLAIM_S} seconds' ` +
        `WHERE id IN (SELECT i.id FROM ${WAKEUP_INSTANCES_TABLE} i ${LIVE} WHERE ${WAITING} ` +
        "AND i.at <= $1 AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= $1) " +
        `ORDER BY i.at LIMIT ${ROUND_ROWS} FOR UPDATE OF i SKIP LOCKED) RETURNING id, url, generation`,
      [now()],
    );
    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row && !stopping.signal.aborted; row = queue.shift()) {
        await call(row).catch((err: unknown) => log.warn(`wakeup: could not record a call: ${errorMessage(err)}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    const next = await pool.query<{ next: Date | null }>(
      `SELECT min(greatest(i.at, coalesce(i.next_attempt_at, i.at))) AS next FROM ${WAKEUP_INSTANCES_TABLE} i ` +
        `${LIVE} WHERE ${WAITING}`,
    );
    return next.rows[0]?.next ?? undefined;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const running = (async () => {
    while (!stopping.signal.aborted) {
      poked = false;
      let ms = MAX_SLEEP_MS;
      try {
        const next = await round();
        if (next) ms = Math.min(Math.max(next.getTime() - now().getTime(), 0), MAX_SLEEP_MS);
      } catch (err) {
        if (stopping.signal.aborted) break;
        log.warn(`wakeup: the loop could not read its instances: ${errorMessage(err)}`);
        ms = 5_000;
      }
      // A poke during the round may have come after its last read: look again at once.
      if (!poked && !stopping.signal.aborted) await sleep(ms);
    }
  })();

  return {
    /** Wakes the loop now, or right after the round in progress. */
    poke() {
      poked = true;
      wakeUp?.();
    },
    async stop() {
      stopping.abort();
      wakeUp?.();
      await running;
    },
  };
}
