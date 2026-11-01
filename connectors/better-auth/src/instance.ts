import { CLIENT_IP_HEADER, requestOrigin } from "@sanoma-ai/workflows";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import { PostgresDialect } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";

// One Better Auth on the company's database, as the visitor and the staff logins both run it: its
// tables in a schema of its own, migrated once per database and schema in a process under an
// advisory lock, its cookies signed with the key the app derives for it, and one instance per
// protocol, since a cookie's `Secure` flag is one per instance.

export type Protocol = "http" | "https";

/** What each login sets on top of what every instance shares. */
export type ExtraOptions = Omit<BetterAuthOptions, "database" | "secret" | "secrets" | "basePath" | "baseURL">;

export interface BetterAuthSetup<O extends ExtraOptions> {
  databaseUrl: string;
  /** The app's key for this login, 32 bytes as hex (`LoginContext.key`). */
  key: string;
  /** The schema its tables are in: `better_auth` for visitors, `better_auth_staff` for staff. */
  schema: string;
  /** Where its routes are: `/auth/better-auth`. */
  basePath: string;
  /** The hosts each protocol's instance answers, as Better Auth's `allowedHosts` takes them. */
  hosts: ReadonlyMap<Protocol, readonly string[]>;
  /** The rest of the options, the same for each protocol's instance. */
  options: O;
}

/** Each database and schema's migration, once per process however many logins run on it. */
const migrated = new Map<string, Promise<void>>();

/**
 * Opens one Better Auth per protocol on the company's database, after its migrations: `auths` by
 * protocol, the `pool` they share, and `close`, which ends it. Throws, the pool ended, when the
 * key is not one the app derived or the migrations fail.
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
    // On only in production by default; in memory, per process.
    rateLimit: { enabled: true },
    logger: { level: "warn" as const },
    ...options,
    // Schema-qualified queries, not a search_path, which the URL's own `options` could undo.
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres" as const,
      schemaName: schema,
      transaction: true,
    },
    // `secrets` over `secret`, else BETTER_AUTH_SECRETS in the environment would win.
    secrets: [{ version: 1, value: key }],
    secret: key,
    basePath,
    // A request's Host must be one of these, and its origin is trusted.
    baseURL: { allowedHosts: [...(hosts.get(protocol) ?? [])], protocol },
    telemetry: { enabled: false },
    advanced: {
      // The app sets it from the socket; Better Auth would otherwise believe a client's X-Forwarded-For.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: protocol === "https",
      // Its default under NODE_ENV=test is off: the same check everywhere.
      disableOriginCheck: false,
      ...options.advanced,
    },
  });
  try {
    const protocols = [...hosts.keys()];
    await migrateOnce(databaseUrl, schema, optionsFor(protocols[0]!));
    // After the migrations: its start checks the tables, and says the schema is out of date otherwise.
    const auths = new Map(protocols.map((protocol) => [protocol, betterAuth(optionsFor(protocol))]));
    return { auths, pool, close: () => pool.end() };
  } catch (err) {
    await pool.end();
    throw err;
  }
}

/** Better Auth's migrations, once per database and schema in this process, under the advisory lock across processes. */
function migrateOnce(databaseUrl: string, schema: string, options: BetterAuthOptions): Promise<void> {
  const at = `${databaseUrl}#${schema}`;
  let done = migrated.get(at);
  if (!done) {
    done = migrate(databaseUrl, schema, options).catch((err: unknown) => {
      migrated.delete(at);
      throw err;
    });
    migrated.set(at, done);
  }
  return done;
}

/**
 * Holds the lock on a session of its own until that ends, whatever fails; polled, never waited
 * for by a blocked statement, as the runtime's own preparation does. The migrations make the schema.
 */
async function migrate(databaseUrl: string, schema: string, options: BetterAuthOptions): Promise<void> {
  const conn = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  // An error nobody listens for ends the process; the query in flight fails with it.
  conn.on("error", (err) => console.warn(`better-auth: the migration's connection failed: ${err.message}`));
  await conn.connect();
  try {
    const ask = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked";
    while (!(await conn.query<{ locked: boolean }>(ask, [`sanoma.login.better-auth.${schema}`])).rows[0]!.locked)
      await delay(50);
    await (await getMigrations(options)).runMigrations();
  } finally {
    await conn.end().catch(() => undefined);
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
