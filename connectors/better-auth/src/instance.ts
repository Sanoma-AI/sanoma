import { CLIENT_IP_HEADER, errorMessage, requestOrigin } from "@sanoma-ai/workflows";
import { applyMigrations, databaseOn, migrationsApplied, pgCode, underPreparationLock } from "@sanoma-ai/workflows/db";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import * as staff from "./db/staff.ts";
import * as visitors from "./db/visitors.ts";
import staffJournal from "../drizzle/staff/meta/_journal.json" with { type: "json" };
import visitorsJournal from "../drizzle/visitors/meta/_journal.json" with { type: "json" };

// One Better Auth on the company's database, as the visitor and the staff logins both run it: its
// tables in a schema of its own, which the worker makes at its start (`prepareBetterAuth`) and the
// app only checks, its cookies signed with the key the app derives for it, its rate limit in a
// table rather than memory, and one instance per protocol, since a cookie's `Secure` flag is one
// per instance. It runs on the pool the app's client gives it (`LoginContext.database`), an
// instance per pool, made on first use: on Node the app's one pool, on a Worker each request's
// own, so nothing of a login lives in the process between requests. Nothing is cached in the
// cookie either: every request reads its session row, so a revoked session, or a `github` a
// sign-in just wrote, is seen at once.

export type Protocol = "http" | "https";

/** What each login sets on top of what every instance shares; the rate limit is the tables' (`TABLE_OPTIONS`). */
export type ExtraOptions = Omit<
  BetterAuthOptions,
  "database" | "secret" | "secrets" | "basePath" | "baseURL" | "rateLimit"
>;

/** The schema each login's tables are in, on the company's database (`db/visitors.ts`, `db/staff.ts`). */
export const SCHEMAS = { visitors: visitors.schema.schemaName, staff: staff.schema.schemaName } as const;
type Schema = (typeof SCHEMAS)[keyof typeof SCHEMAS];

/**
 * Each schema's login: its tables (its `db/` module, Better Auth's models by name, as its Drizzle
 * adapter reads them) and their generated migrations, whose journal tables are the runtime's
 * neighbours in the schema `drizzle`.
 */
const LOGINS = {
  [SCHEMAS.visitors]: {
    tables: visitors,
    migrations: {
      folder: () => new URL("../drizzle/visitors/", import.meta.url),
      table: "__drizzle_migrations_better_auth",
      journal: visitorsJournal,
    },
  },
  [SCHEMAS.staff]: {
    tables: staff,
    migrations: {
      folder: () => new URL("../drizzle/staff/", import.meta.url),
      table: "__drizzle_migrations_better_auth_staff",
      journal: staffJournal,
    },
  },
};

export interface BetterAuthSetup<O extends ExtraOptions> {
  /** The pool the app's client runs on (`LoginContext.database`): one instance per pool it gives. */
  database(): Promise<Pool>;
  /** The app's key for this login, 32 bytes as hex (`LoginContext.key`). */
  key: string;
  /** The schema its tables are in (`SCHEMAS`). */
  schema: Schema;
  /** Where its routes are: `/auth/better-auth`. */
  basePath: string;
  /** The hosts each protocol's instance answers, as Better Auth's `allowedHosts` takes them. */
  hosts: ReadonlyMap<Protocol, readonly string[]>;
  /** The rest of the options, the same for each protocol's instance. */
  options: O;
}

/**
 * What shapes the tables beyond Better Auth's own, the same for both logins and laid over theirs,
 * as `db/tables.ts` declares them: the user's `github` column (the GitHub login: never a person's
 * input, so only the login sets it), and the rate limit's table (`rateLimit.storage: "database"`,
 * so a limit holds across processes and requests). The plugins they run (the email code, magic
 * links) keep no tables of their own.
 */
export const TABLE_OPTIONS = {
  user: { additionalFields: { github: { type: "string" as const, required: false, input: false } } },
  rateLimit: { storage: "database" as const },
};

/**
 * Each database and schema found prepared, for the process's life: a pool that finds its schema
 * prepared spares every pool on that database the check after it. A check in flight is its own
 * pool's and no one else's (on a Worker a request's pool goes with the request), so nothing waits
 * on another request's work, and a failed check leaves nothing behind.
 */
const prepared = new Set<string>();

/** What a pool connects to, as the key a check is remembered by: its connection string, else its host and database. */
function databaseOf(pool: Pool): string {
  const { connectionString, host, port, database } = pool.options;
  return connectionString ?? `${host}:${port}/${database}`;
}

/** How long an opening login waits for a worker starting beside it to prepare the schema, and how often it looks. */
const PREPARED_WAIT_MS = 60_000;
const PREPARED_POLL_MS = 1_000;

/**
 * Better Auth on the company's database, as a function of the request's protocol: the instance
 * for that protocol on the pool `database` gives now, made on its first use (one per pool and
 * protocol, kept as long as the pool is). Throws when the key is not one the app derived; its
 * first use on a pool throws when the schema's tables are still not there, or behind this
 * version's, a minute after a worker starting beside the app should have made them
 * (`prepareBetterAuth`).
 */
export function openBetterAuth<O extends ExtraOptions>({
  database,
  key,
  schema,
  basePath,
  hosts,
  options,
}: BetterAuthSetup<O>) {
  // Never Better Auth's own fallback (an environment variable, or its default secret).
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("better-auth: the app gives no key to sign cookies with");
  const optionsFor = (pool: Pool, protocol: Protocol) => ({
    // On only in production by default; its counts in the schema's table, never in memory.
    rateLimit: { enabled: true, ...TABLE_OPTIONS.rateLimit },
    logger: { level: "warn" as const },
    ...options,
    user: { ...options.user, ...TABLE_OPTIONS.user },
    // The schema's own tables, so no search_path, which the URL's own `options` could undo.
    database: drizzleAdapter(databaseOn(pool), { provider: "pg", schema: LOGINS[schema].tables, transaction: true }),
    // `secrets` over `secret`, else BETTER_AUTH_SECRETS in the environment would win.
    secrets: [{ version: 1, value: key }],
    secret: key,
    basePath,
    // A request's Host must be one of these, and its origin is trusted.
    baseURL: { allowedHosts: [...(hosts.get(protocol) ?? [])], protocol },
    telemetry: { enabled: false },
    advanced: {
      // The app sets it from the socket, or from its host's own header; Better Auth would
      // otherwise believe a client's X-Forwarded-For.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: protocol === "https",
      // Its default under NODE_ENV=test is off: the same check everywhere.
      disableOriginCheck: false,
      ...options.advanced,
    },
  });
  type Auth = ReturnType<typeof betterAuth<ReturnType<typeof optionsFor>>>;
  /** Each pool's instances, by protocol, for as long as the pool is referenced. */
  const made = new WeakMap<Pool, Map<Protocol, Auth>>();
  return async (protocol: Protocol): Promise<Auth> => {
    const pool = await database();
    const found = `${databaseOf(pool)}#${schema}`;
    if (!prepared.has(found)) {
      await checkPrepared(pool, schema);
      prepared.add(found);
    }
    let auths = made.get(pool);
    if (!auths) made.set(pool, (auths = new Map()));
    let auth = auths.get(protocol);
    if (!auth) auths.set(protocol, (auth = betterAuth(optionsFor(pool, protocol))));
    return auth;
  };
}

/**
 * Waits for the database to have had every migration of `schema`'s tables (by its journal, as
 * `prepareDatabase` checks the runtime's own), looking every second for a minute, since a
 * deployment's worker starts beside its app; then refuses: the worker makes them, and the app
 * never does.
 */
async function checkPrepared(pool: Pool, schema: Schema): Promise<void> {
  const db = databaseOn(pool);
  for (const deadline = Date.now() + PREPARED_WAIT_MS; ; await delay(PREPARED_POLL_MS)) {
    if (await migrationsApplied(db, LOGINS[schema].migrations)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `better-auth: the database's ${schema} tables are missing or behind this version's: the worker makes them at its start, and the app never does`,
      );
  }
}

/** `run` once per `key` in this process, again after it fails. */
function once(memo: Map<string, Promise<void>>, key: string, run: () => Promise<void>): Promise<void> {
  let done = memo.get(key);
  if (!done) {
    done = run().catch((err: unknown) => {
      memo.delete(key);
      throw err;
    });
    memo.set(key, done);
  }
  return done;
}

/** Each database and schema's migration, once per process however many workers run on it. */
const migrated = new Map<string, Promise<void>>();

/** Postgres's code for a schema that is already there (`duplicate_schema`). */
const SCHEMA_EXISTS = "42P06";

/**
 * The preparation of one login's `schema`: the migrations its database has not had, once per
 * process, under the preparation's lock across processes (the runtime's own, which makes the
 * database first when missing): two workers starting at once both succeed, the second finding
 * everything made. A schema with no journal is one a release before these migrations made, with
 * Better Auth's own, of another shape: refused, naming the drop that resets it.
 */
const preparing =
  (schema: Schema) =>
  (databaseUrl: string): Promise<void> =>
    once(migrated, `${databaseUrl}#${schema}`, () =>
      underPreparationLock(databaseUrl, (db) => applyMigrations(db, LOGINS[schema].migrations)).catch(
        (err: unknown) => {
          const why =
            pgCode(err) === SCHEMA_EXISTS
              ? `the schema ${schema} has no journal (drizzle.${LOGINS[schema].migrations.table}): a release before this one made it, or the journal table was lost; drop the schema (DROP SCHEMA ${schema} CASCADE; its users sign in again), or restore the journal, and start the worker again`
              : errorMessage(err);
          throw new Error(`better-auth: could not prepare ${schema}: ${why}`, { cause: err });
        },
      ),
    );

/**
 * Makes the visitor login's tables (`better_auth`) on the company's database: the connector's
 * `prepare`, which the worker runs at its start on the database's direct URL. Idempotent: a
 * second run changes nothing.
 */
export const prepareBetterAuth = preparing(SCHEMAS.visitors);

/** Makes the staff login's tables (`better_auth_staff`), as `prepareBetterAuth` the visitors': the launcher's worker runs it, since no config names that login. */
export const prepareBetterAuthStaff = preparing(SCHEMAS.staff);

/** A request's protocol: https when it came over TLS or through a proxy that says so (`x-forwarded-proto`). */
export const protocolOf = (request: Request): Protocol =>
  requestOrigin(request).startsWith("https:") ? "https" : "http";

/**
 * The app's Sign out POSTs no body, which Better Auth's sign-out answers with 415: the request
 * with an empty JSON body; any other request as it is.
 */
export function withSignOutBody(request: Request, signOut: string): Request {
  if (new URL(request.url).pathname !== signOut || request.method !== "POST" || request.headers.has("content-type"))
    return request;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: "{}" });
}

/**
 * Better Auth's email OTP for the code `sendCode` mails: six digits, five minutes, three tries,
 * kept hashed; a sign-in code only (no email verification or password reset, which nothing here
 * offers). Without `sendCode` nothing is sent, and the login refuses its routes.
 */
export const emailCode = (sendCode?: (email: string, code: string) => Promise<void>) =>
  emailOTP({
    otpLength: 6,
    expiresIn: 300,
    storeOTP: "hashed",
    allowedAttempts: 3,
    async sendVerificationOTP({ email, otp, type }) {
      if (type === "sign-in") await sendCode?.(email, otp);
    },
  });

/** The query parameters Better Auth redirects to. */
const REDIRECTS = ["callbackURL", "errorCallbackURL", "newUserCallbackURL"];

/** Whether each redirect a request names is a path on its own host: `/x`, never `//x` or another origin. */
export const localRedirects = (url: URL) =>
  REDIRECTS.every((name) => {
    const to = url.searchParams.get(name);
    return to === null || (to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\"));
  });

/** A user row, as far as who it vouches for reads it. */
export interface User {
  email: string;
  emailVerified: boolean;
  github?: string | null;
}

/** What a user row vouches for: the email when verified, the GitHub login when GitHub said it. */
export const identityOf = (user: User) => ({
  ...(user.emailVerified && { email: user.email }),
  ...(user.github && { github: user.github }),
});
