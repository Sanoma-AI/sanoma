import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "@sanoma-ai/workflows";
import { type BetterAuthOptions, betterAuth, getHostFromSource, matchesHostPattern } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { PostgresDialect } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";

/** The schema Better Auth's tables (`user`, `session`, `account`, `verification`) live in, on the company's database. */
const SCHEMA = "better_auth";
/** Where its routes are: a site's pages POST to `<BASE_PATH>/sign-up/email`, `/sign-in/email` and `/sign-out`. */
const BASE_PATH = "/auth/better-auth";
const SIGN_OUT = `${BASE_PATH}/sign-out`;
/** The advisory lock every process takes around the migrations: concurrent cold starts race otherwise. */
const LOCK = "sanoma.login.better-auth";

/** Each database's migration, once per process however many sites sign in through it. */
const migrated = new Map<string, Promise<void>>();

/**
 * Better Auth's login half for one public site: email and password, its tables in schema
 * `better_auth` on the company's database, migrated here before the first site starts, its cookies
 * signed with the app's key for it (`context.key`). The site's origins are its allowed hosts (a
 * request for another host is refused) and set the cookie's `Secure` flag: an `https` origin's is.
 */
export async function betterAuthLogin({ databaseUrl, key, origins }: LoginContext): Promise<LoginHalf> {
  // Never Better Auth's own fallback (an environment variable, or its default secret).
  if (!/^[0-9a-f]{64}$/.test(key ?? "")) throw new Error("better-auth: the app gives no key to sign cookies with");
  const sites = sitesOf(origins);
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err) => console.warn(`better-auth: a database connection failed: ${err.message}`));
  // One Better Auth per protocol, since its cookies' `Secure` flag is one per instance.
  const optionsFor = (protocol: Protocol) =>
    ({
      // Schema-qualified queries, not a search_path, which the URL's own `options` could undo.
      database: { dialect: new PostgresDialect({ pool }), type: "postgres", schemaName: SCHEMA, transaction: true },
      // `secrets` over `secret`, else BETTER_AUTH_SECRETS in the environment would win.
      secrets: [{ version: 1, value: key }],
      secret: key,
      basePath: BASE_PATH,
      // A request's Host must be one of these, and its origin is trusted.
      baseURL: { allowedHosts: sites.filter((site) => site.protocol === protocol).map((site) => site.host), protocol },
      emailAndPassword: { enabled: true },
      telemetry: { enabled: false },
      advanced: {
        // The app sets it from the socket; Better Auth would otherwise believe a client's X-Forwarded-For.
        ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
        useSecureCookies: protocol === "https",
        // Its default under NODE_ENV=test is off: the same check everywhere.
        disableOriginCheck: false,
      },
      // On only in production by default; in memory, per process.
      rateLimit: { enabled: true },
      logger: { level: "warn" },
    }) satisfies BetterAuthOptions;
  try {
    const protocols = [...new Set(sites.map((site) => site.protocol))];
    await migrateOnce(databaseUrl, optionsFor(protocols[0]!));
    // After the migrations: its start checks the tables, and says the schema is out of date otherwise.
    const auths = new Map(protocols.map((protocol) => [protocol, betterAuth(optionsFor(protocol))]));
    /** The instance for the request's host, or none for a host that is not the site's. */
    const authFor = (request: Request) => {
      const host = getHostFromSource(request, false) ?? "";
      const site = sites.find((s) => matchesHostPattern(host, s.host));
      return site && auths.get(site.protocol);
    };
    return {
      async verify(request) {
        const auth = authFor(request);
        if (!auth) throw new Error(`better-auth: ${request.headers.get("host")} is not one of the site's hosts`);
        // Null for a missing, bad or signed-out cookie.
        const session = await auth.api.getSession({ headers: request.headers });
        return session ? { subject: session.user.id } : null;
      },
      async handle(request) {
        const { pathname } = new URL(request.url);
        if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;
        // Better Auth throws for a host it does not allow, which would be a 500.
        const auth = authFor(request);
        if (!auth) return new Response("Misdirected Request", { status: 421 });
        // The app's Sign out POSTs no body, which Better Auth's sign-out answers with 415.
        if (pathname === SIGN_OUT && request.method === "POST" && !request.headers.has("content-type")) {
          const headers = new Headers(request.headers);
          headers.set("content-type", "application/json");
          headers.delete("content-length");
          return auth.handler(new Request(request.url, { method: "POST", headers, body: "{}" }));
        }
        return auth.handler(request);
      },
      signOut: SIGN_OUT,
      close: () => pool.end(),
    };
  } catch (err) {
    await pool.end();
    throw err;
  }
}

type Protocol = "http" | "https";

/** Each origin's host, as Better Auth's `allowedHosts` has it (`account.localhost:*`), and its protocol. */
function sitesOf(origins: readonly string[]): { host: string; protocol: Protocol }[] {
  if (!origins.length) throw new Error("better-auth: a site needs an origin");
  return origins.map((origin) => {
    const [, protocol, host] = /^(https?):\/\/([^/]+)$/.exec(origin) ?? [];
    if (!host)
      throw new Error(
        `better-auth: an origin is a scheme and a host alone, such as https://example.com, not ${origin}`,
      );
    return { host, protocol: protocol as Protocol };
  });
}

/** Better Auth's migrations, once per database in this process, under the advisory lock across processes. */
function migrateOnce(databaseUrl: string, options: BetterAuthOptions): Promise<void> {
  let done = migrated.get(databaseUrl);
  if (!done) {
    done = migrate(databaseUrl, options).catch((err: unknown) => {
      migrated.delete(databaseUrl);
      throw err;
    });
    migrated.set(databaseUrl, done);
  }
  return done;
}

/**
 * Holds the lock on a session of its own until that ends, whatever fails; polled, never waited
 * for by a blocked statement, as the runtime's own preparation does. The migrations make the schema.
 */
async function migrate(databaseUrl: string, options: BetterAuthOptions): Promise<void> {
  const conn = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  // An error nobody listens for ends the process; the query in flight fails with it.
  conn.on("error", (err) => console.warn(`better-auth: the migration's connection failed: ${err.message}`));
  await conn.connect();
  try {
    const ask = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked";
    while (!(await conn.query<{ locked: boolean }>(ask, [LOCK])).rows[0]!.locked) await delay(50);
    await (await getMigrations(options)).runMigrations();
  } finally {
    await conn.end().catch(() => undefined);
  }
}
