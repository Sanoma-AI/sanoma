import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type Db, databaseOn, openPool, underPreparationLock } from "./db.ts";
import { applyMigrations, WAKEUP_MIGRATIONS } from "./db/migrate.ts";
import { wakeupAccounts, wakeupInstances } from "./db/wakeup.ts";
import { info, warn } from "./log.ts";
import { generateSecret, tokenHash as hashOf } from "./secret.ts";
import { errorMessage } from "./shared.ts";

/*
 * `@sanoma-ai/workflows/wakeup-service`: the service that wakes stopped instances, server-side
 * only. An account (minted by whoever runs the service) registers an instance by its URL and the
 * instance's own token, which the company mints (`mintInstanceToken`) and keeps; the instance,
 * before it stops, `PUT`s with that token when it wants waking, replacing what it asked before;
 * the service then calls `GET {url}/wake`, retrying until an answer is a 2xx. It makes its two
 * tables itself, in the database it is given (sanoma-ops's own, when it hosts it): never among
 * `db.ts`'s, which every company's database gets.
 */

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
 * A new instance token (`swi_…`), which the company mints and stores as `SANOMA_WAKEUP_TOKEN`
 * before anything is applied, so its host is given it from the first apply; the wakeup's create
 * then registers it with the service. The service never mints one.
 */
export const mintInstanceToken = () => newToken("swi_");

/** The secret a company keeps its instance token in: what its host's `secrets` name and its wakeup's driver reads. */
export const WAKEUP_TOKEN = "SANOMA_WAKEUP_TOKEN";

/** An instance token the service takes: `swi_`, then at least as many base64url characters as a minted one has. */
export const INSTANCE_TOKEN = /^swi_[\w-]{43,256}$/;

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
 * user or password, no query, no fragment (`/wake` is added to it).
 */
export function instanceUrl(value: unknown): { url: string } | { error: string } {
  const refused = { error: "url must be an http(s) URL with no user, password, query or fragment" };
  if (typeof value !== "string" || /[?#]/.test(value) || !URL.canParse(value)) return refused;
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return refused;
  return { url: url.href.replace(/\/+$/, "") };
}

type InstanceRow = typeof wakeupInstances.$inferSelect;

/** An instance as `GET` shows it to its account. */
const shownInstance = (row: InstanceRow) => ({
  id: row.id,
  url: row.url,
  at: row.at?.toISOString() ?? null,
  calledAt: row.calledAt?.toISOString() ?? null,
  attempts: row.attempts,
  lastError: row.lastError,
});

/** A row waiting for its call: registered, not called since its `at`. */
const waiting = and(
  isNotNull(wakeupInstances.at),
  or(isNull(wakeupInstances.calledAt), lt(wakeupInstances.calledAt, wakeupInstances.at)),
);
/** The join to an account not revoked. */
const live = and(eq(wakeupAccounts.id, wakeupInstances.accountId), isNull(wakeupAccounts.revokedAt));

/**
 * Runs `use` on a connection to `databaseUrl` holding the preparation's lock, the database and the
 * service's two tables made when missing: the service's own migrations folder, with its own journal
 * table, since the database may be a company's too.
 */
function withTables<T>(databaseUrl: string, use: (db: Db) => Promise<T>): Promise<T> {
  return underPreparationLock(databaseUrl, async (db) => {
    await applyMigrations(db, WAKEUP_MIGRATIONS).catch((err: unknown) => {
      throw new Error(`could not prepare the wakeup service tables: ${errorMessage(err)}`, { cause: err });
    });
    return use(db);
  });
}

async function insertAccount(db: Db, label: string): Promise<{ id: string; token: string }> {
  if (!label.trim()) throw new Error("An account's label must not be empty");
  const id = randomUUID();
  const token = newToken("swa_");
  await db.insert(wakeupAccounts).values({ id, tokenHash: hashOf(token), label });
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
 * - `POST /wakeup/instances { url, token }`, an account's token → 201 `{ id }` for a new instance
 *   token, 200 `{ id }` for one the account registered already, its URL now the given one (a lost
 *   reply, or a host that moved; its registered wake kept only when the URL is the same), 409 for
 *   another account's
 * - `GET /wakeup/instances/{id}`, its account's token → `{ id, url, at, calledAt, attempts, lastError }`
 * - `DELETE /wakeup/instances/{id}`, its account's token → 204
 * - `PUT /wakeup/wake { at }`, an instance's own token, which names the instance → 204, replacing
 *   the wake it had, and waking the loop
 *
 * 401 without a token or with an unknown one, 403 for another account's instance, 400 for a bad
 * body, 404 for an unknown id or path.
 */
export async function startWakeupService({
  databaseUrl,
  now = () => new Date(),
  fetch = globalThis.fetch,
  log = { info, warn },
}: WakeupServiceOptions): Promise<WakeupService> {
  await withTables(databaseUrl, async () => {});
  const pool = openPool(databaseUrl, "wakeup service");
  const db = databaseOn(pool);
  const loop = startLoop({ db, now, fetch, log });

  /** The live account the request's token is, or a 401. */
  async function account(request: Request): Promise<string | Response> {
    const token = bearer(request);
    if (!token?.startsWith("swa_")) return problem(401, "an account's token is needed");
    const [row] = await db
      .select({ id: wakeupAccounts.id })
      .from(wakeupAccounts)
      .where(and(eq(wakeupAccounts.tokenHash, hashOf(token)), isNull(wakeupAccounts.revokedAt)));
    return row?.id ?? problem(401, "the token is no account's");
  }

  /** The account's instance `id`, or a 404, or a 403 when it is another account's. */
  async function owned(accountId: string, id: string): Promise<InstanceRow | Response> {
    if (!UUID.test(id)) return problem(404, "no such instance");
    const [row] = await db.select().from(wakeupInstances).where(eq(wakeupInstances.id, id));
    if (!row) return problem(404, "no such instance");
    return row.accountId === accountId ? row : problem(403, "the instance is another account's");
  }

  async function register(request: Request): Promise<Response> {
    const accountId = await account(request);
    if (accountId instanceof Response) return accountId;
    const given = await jsonBody(request);
    if (given instanceof Response) return given;
    const checked = instanceUrl(given?.url);
    if ("error" in checked) return problem(400, checked.error);
    const token = given?.token;
    if (typeof token !== "string" || !INSTANCE_TOKEN.test(token))
      return problem(400, "token must be an instance's token: swi_, then 43 or more base64url characters");
    // The token names the instance: a new one is a new row, one of this account's is moved to the
    // URL given, and another account's is refused (no row returned).
    const id = randomUUID();
    const sameUrl = sql`${wakeupInstances.url} = ${checked.url}`;
    const [row] = await db
      .insert(wakeupInstances)
      .values({ id, accountId, url: checked.url, tokenHash: hashOf(token) })
      .onConflictDoUpdate({
        target: wakeupInstances.tokenHash,
        set: {
          url: checked.url,
          at: sql`CASE WHEN ${sameUrl} THEN ${wakeupInstances.at} END`,
          calledAt: sql`CASE WHEN ${sameUrl} THEN ${wakeupInstances.calledAt} END`,
          attempts: sql`CASE WHEN ${sameUrl} THEN ${wakeupInstances.attempts} ELSE 0 END`,
          nextAttemptAt: sql`CASE WHEN ${sameUrl} THEN ${wakeupInstances.nextAttemptAt} END`,
          lastError: sql`CASE WHEN ${sameUrl} THEN ${wakeupInstances.lastError} END`,
        },
        setWhere: eq(wakeupInstances.accountId, accountId),
      })
      .returning({ id: wakeupInstances.id, made: sql<boolean>`${wakeupInstances.id} = ${id}::uuid` });
    if (!row) {
      return problem(409, "the token is another account's instance's");
    }
    return json(row.made ? 201 : 200, { id: row.id });
  }

  async function wake(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token?.startsWith("swi_")) return problem(401, "an instance's token is needed");
    const [found] = await db
      .select({ id: wakeupInstances.id })
      .from(wakeupInstances)
      .innerJoin(wakeupAccounts, live)
      .where(eq(wakeupInstances.tokenHash, hashOf(token)));
    const id = found?.id;
    if (!id) return problem(401, "the token is no instance's");
    const given = await jsonBody(request);
    if (given instanceof Response) return given;
    const at = given?.at;
    if (typeof at !== "string" || !ISO_DATE_TIME.test(at) || Number.isNaN(Date.parse(at)))
      return problem(400, "at must be an ISO 8601 date-time");
    // Whatever it had is replaced: a wake that arrives for an older one starts a worker with nothing to do.
    await db
      .update(wakeupInstances)
      .set({ at: new Date(at), calledAt: null, attempts: 0, nextAttemptAt: null, lastError: null })
      .where(eq(wakeupInstances.id, id));
    loop.poke();
    return noContent();
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (path === "/wakeup/instances") {
      return method === "POST" ? register(request) : notAllowed("POST");
    }
    // Its token says which instance it is.
    if (path === "/wakeup/wake") return method === "PUT" ? wake(request) : notAllowed("PUT");
    const match = /^\/wakeup\/instances\/([^/]+)$/.exec(path);
    if (!match) return problem(404, "no such route");
    const id = match[1]!;
    if (method !== "GET" && method !== "DELETE") return notAllowed("GET, DELETE");
    const accountId = await account(request);
    if (accountId instanceof Response) return accountId;
    const row = await owned(accountId, id);
    if (row instanceof Response) return row;
    if (method === "GET") return json(200, shownInstance(row));
    await db.delete(wakeupInstances).where(eq(wakeupInstances.id, id));
    return noContent();
  }

  return {
    routes: [{ path: "/wakeup", prefix: true, handle }],
    mintAccount: (label) => insertAccount(db, label),
    async revokeAccount(id) {
      if (!UUID.test(id)) return;
      await db
        .update(wakeupAccounts)
        .set({ revokedAt: now() })
        .where(and(eq(wakeupAccounts.id, id), isNull(wakeupAccounts.revokedAt)));
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
  at: Date;
}

/**
 * The one loop: calls every row that is due, at most `CONCURRENCY` at once, then sleeps until the
 * next is (at most `MAX_SLEEP_MS`) or until `poke`. A failed call is tried again after
 * `min(2^attempts s, MAX_BACKOFF_S)`, for as long as it takes: no row is ever dropped.
 */
function startLoop({
  db,
  now,
  fetch,
  log,
}: {
  db: Db;
  now: () => Date;
  fetch: typeof globalThis.fetch;
  log: { info(line: string): void; warn(line: string): void };
}) {
  const stopping = new AbortController();
  let poked = false;
  let wakeUp: (() => void) | undefined;

  /** Calls `row`'s instance once, and records how it went, unless the registration changed meanwhile. */
  async function call(row: Due) {
    const target = `${row.url}/wake`;
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
    // Recorded only on the registration called: one replaced (another `at`), or moved to another
    // URL, is called again.
    const same = and(eq(wakeupInstances.id, row.id), eq(wakeupInstances.at, row.at), eq(wakeupInstances.url, row.url));
    if (error === undefined) {
      await db
        .update(wakeupInstances)
        .set({ calledAt: now(), attempts: 0, nextAttemptAt: null, lastError: null })
        .where(same);
      log.info(`wakeup: called ${target}`);
    } else {
      await db
        .update(wakeupInstances)
        .set({
          attempts: sql`${wakeupInstances.attempts} + 1`,
          lastError: error,
          nextAttemptAt: sql`${now().toISOString()}::timestamptz + least(power(2, ${wakeupInstances.attempts}), ${sql.raw(String(MAX_BACKOFF_S))}) * interval '1 second'`,
        })
        .where(same);
      log.warn(`wakeup: calling ${target} failed (${error}); it is tried again`);
    }
  }

  /** Calls every due row; returns when the next one is due, or undefined with none waiting. */
  async function round(): Promise<Date | undefined> {
    // Taken for `CLAIM_S`, rows another service holds skipped: each due row is called by one service.
    const at = now();
    const due = db
      .select({ id: wakeupInstances.id })
      .from(wakeupInstances)
      .innerJoin(wakeupAccounts, live)
      .where(
        and(
          waiting,
          lte(wakeupInstances.at, at),
          or(isNull(wakeupInstances.nextAttemptAt), lte(wakeupInstances.nextAttemptAt, at)),
        ),
      )
      .orderBy(wakeupInstances.at)
      .limit(ROUND_ROWS)
      .for("update", { of: wakeupInstances, skipLocked: true });
    const rows = await db
      .update(wakeupInstances)
      .set({ nextAttemptAt: sql`${at.toISOString()}::timestamptz + ${sql.raw(String(CLAIM_S))} * interval '1 second'` })
      .where(inArray(wakeupInstances.id, due))
      .returning({ id: wakeupInstances.id, url: wakeupInstances.url, at: wakeupInstances.at });
    const queue = rows.flatMap((r): Due[] => (r.at ? [{ ...r, at: r.at }] : []));
    const worker = async () => {
      for (let row = queue.shift(); row && !stopping.signal.aborted; row = queue.shift()) {
        await call(row).catch((err: unknown) => log.warn(`wakeup: could not record a call: ${errorMessage(err)}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    const [next] = await db
      .select({
        next: sql<Date | null>`min(greatest(${wakeupInstances.at}, coalesce(${wakeupInstances.nextAttemptAt}, ${wakeupInstances.at})))`.mapWith(
          wakeupInstances.at,
        ),
      })
      .from(wakeupInstances)
      .innerJoin(wakeupAccounts, live)
      .where(waiting);
    return next?.next ?? undefined;
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
