import { CLIENT_IP_HEADER, requestOrigin } from "@sanoma-ai/workflows";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import { PostgresDialect } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";

// One Better Auth on the company's database, as the visitor and the staff logins both run it: its
// tables in a schema of its own, which the worker makes at its start (`prepareBetterAuth`) and the
// app only checks, its cookies signed with the key the app derives for it, its rate limit in a
// table rather than memory, and one instance per protocol, since a cookie's `Secure` flag is one
// per instance. Nothing is cached in the cookie: every request reads its session row, so a
// revoked session, or a `github` a sign-in just wrote, is seen at once.

export type Protocol = "http" | "https";

/** What each login sets on top of what every instance shares; the rate limit is the tables' (`TABLE_OPTIONS`). */
export type ExtraOptions = Omit<
  BetterAuthOptions,
  "database" | "secret" | "secrets" | "basePath" | "baseURL" | "rateLimit"
>;

/** The schema each login's tables are in, on the company's database. */
export const SCHEMAS = { visitors: "better_auth", staff: "better_auth_staff" } as const;
type Schema = (typeof SCHEMAS)[keyof typeof SCHEMAS];

export interface BetterAuthSetup<O extends ExtraOptions> {
  databaseUrl: string;
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
 * What shapes the tables, the same for both logins and laid over theirs: the user's `github`
 * column (the GitHub login: never a person's input, so only the login sets it), and the rate
 * limit's table (`rateLimit.storage: "database"`, so a limit holds across processes and
 * requests). The plugins they run (the email code, magic links) keep no tables of their own.
 */
const TABLE_OPTIONS = {
  user: { additionalFields: { github: { type: "string" as const, required: false, input: false } } },
  rateLimit: { storage: "database" as const },
};

/** Better Auth's database options for `schema`, on `pool`: the migrations' and the instances' the same. */
const databaseOn = (pool: Pool, schema: Schema) => ({
  dialect: new PostgresDialect({ pool }),
  type: "postgres" as const,
  // Schema-qualified queries, not a search_path, which the URL's own `options` could undo.
  schemaName: schema,
  transaction: true,
});

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

/** Each database and schema checked for its tables, once per process. */
const checked = new Map<string, Promise<void>>();

/** How long an opening login waits for a worker starting beside it to prepare the schema, and how often it looks. */
const PREPARED_WAIT_MS = 60_000;
const PREPARED_POLL_MS = 1_000;

/**
 * Opens one Better Auth per protocol on the company's database: `auths` by protocol, the `pool`
 * they share, and `close`, which ends it. Throws, the pool ended, when the key is not one the app
 * derived, or when the schema's tables are still not there, or behind this version's, a minute
 * after a worker starting beside the app should have made them (`prepareBetterAuth`).
 */
export async function openBetterAuth<O extends ExtraOptions>({
  databaseUrl,
  key,
  schema,
  basePath,
  hosts,
  options,
}: BetterAuthSetup<O>) {
  // Never Better Auth's own fallback (an environment variable, or its default secret).
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("better-auth: the app gives no key to sign cookies with");
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err) => console.warn(`better-auth: a database connection failed: ${err.message}`));
  const optionsFor = (protocol: Protocol) => ({
    // On only in production by default; its counts in the schema's table, never in memory.
    rateLimit: { enabled: true, ...TABLE_OPTIONS.rateLimit },
    logger: { level: "warn" as const },
    ...options,
    user: { ...options.user, ...TABLE_OPTIONS.user },
    database: databaseOn(pool, schema),
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
  try {
    await once(checked, `${databaseUrl}#${schema}`, () => checkPrepared(pool, schema));
    const auths = new Map([...hosts.keys()].map((protocol) => [protocol, betterAuth(optionsFor(protocol))]));
    return { auths, pool, close: () => pool.end() };
  } catch (err) {
    await pool.end();
    throw err;
  }
}

/**
 * Waits for `schema` to hold every table and column this version's migrations would make (Better
 * Auth's own migration plan, read and never run), looking every second for a minute, since a
 * deployment's worker starts beside its app; then refuses: the worker makes them, and the app
 * never does.
 */
async function checkPrepared(pool: Pool, schema: Schema): Promise<void> {
  const database = databaseOn(pool, schema);
  for (const deadline = Date.now() + PREPARED_WAIT_MS; ; await delay(PREPARED_POLL_MS)) {
    const { toBeCreated, toBeAdded } = await getMigrations({ ...TABLE_OPTIONS, database });
    if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error(
        `better-auth: the database's ${schema} tables are missing or behind this version's: the worker makes them at its start, and the app never does`,
      );
  }
}

/** Each database and schema's migration, once per process however many workers run on it. */
const migrated = new Map<string, Promise<void>>();

/** The preparation of one login's `schema`: its migrations, once per process, under an advisory lock across processes. */
const preparing =
  (schema: Schema) =>
  (databaseUrl: string): Promise<void> =>
    once(migrated, `${databaseUrl}#${schema}`, () => migrate(databaseUrl, schema));

/**
 * Makes the visitor login's tables (`better_auth`) on the company's database: the connector's
 * `prepare`, which the worker runs at its start on the database's direct URL. Idempotent: a
 * second run changes nothing.
 */
export const prepareBetterAuth = preparing(SCHEMAS.visitors);

/** Makes the staff login's tables (`better_auth_staff`), as `prepareBetterAuth` the visitors': the launcher's worker runs it, since no config names that login. */
export const prepareBetterAuthStaff = preparing(SCHEMAS.staff);

/**
 * Holds the lock on a session of its own until that ends, whatever fails; polled, never waited
 * for by a blocked statement, as the runtime's own preparation does. The migrations make the
 * schema, on a pool of their own, ended after.
 */
async function migrate(databaseUrl: string, schema: Schema): Promise<void> {
  const conn = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  // An error nobody listens for ends the process; the query in flight fails with it.
  conn.on("error", (err) => console.warn(`better-auth: the migration's connection failed: ${err.message}`));
  await conn.connect();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const ask = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked";
    while (!(await conn.query<{ locked: boolean }>(ask, [`sanoma.login.better-auth.${schema}`])).rows[0]!.locked)
      await delay(50);
    await (await getMigrations({ ...TABLE_OPTIONS, database: databaseOn(pool, schema) })).runMigrations();
  } finally {
    await Promise.allSettled([conn.end(), pool.end()]);
  }
}

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
