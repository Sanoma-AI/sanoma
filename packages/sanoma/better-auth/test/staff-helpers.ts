import { createHash, randomBytes } from "node:crypto";
import { Client, type Pool } from "pg";
import { CLIENT_IP_HEADER, type LoginHalf } from "sanoma/workflows";
import { expect } from "vitest";

// What the staff login's tests share: Claude Code's client as a stand-in serves it, a session's
// cookie, the staff schema as the worker first finds it, and a client's sign-in step by step
// (a request to the login, PKCE, authorize, the sign-in by code, consent, the code for tokens).

/** Claude Code's published client id: the URL of its metadata document. */
export const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

/** Claude Code's document, as claude.ai serves it. */
export const CLAUDE_CODE_DOCUMENT = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** The session cookie an answer sets, as a browser sends it back; empty when it sets none. */
export const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/**
 * The test database with no staff schema and no journal of it, as the worker first finds one:
 * the database made when missing, `better_auth_staff` and its journal table dropped.
 */
export async function resetStaffSchema(databaseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href });
  await admin.connect();
  const name = new URL(databaseUrl).pathname.slice(1);
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await client.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth_staff");
  await client.end();
}

/** A redirect on the person's own computer, as Claude Code's. */
export const REDIRECT = "http://localhost:53682/callback";

/** What a request to the login may carry. */
export interface RequestInit {
  body?: unknown;
  form?: Record<string, string>;
  cookie?: string;
  /** The page's own origin unless given; null for a client's request, which sends none. */
  origin?: string | null;
  bearer?: string;
  /** Another Host than the login's own. */
  host?: string;
}

/**
 * Requests to the login on `host`, through TLS, each from an address of its own under `subnet`
 * (the rate limit counts by address): from the page's own origin unless `origin` is null (a client's).
 */
export function requestsTo(host: string, subnet: string) {
  let nextIp = 1;
  return (path: string, init: RequestInit = {}): Request => {
    const at = init.host ?? host;
    const headers = new Headers({
      host: at,
      "x-forwarded-proto": "https",
      [CLIENT_IP_HEADER]: `${subnet}.${nextIp++}`,
    });
    if (init.origin !== null) headers.set("origin", init.origin ?? `https://${at}`);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    } else if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    }
    return new Request(`http://${at}${path}`, { method: body === undefined ? "GET" : "POST", headers, body });
  };
}

/** A PKCE pair: the verifier, and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The authorization request a client opens in the browser: `client`'s, for `resource`, to `REDIRECT` unless `extra` says another. */
export function authorizePath(client: string, challenge: string, resource: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "offline_access",
    resource,
    ...extra,
  });
  return `/auth/better-auth/oauth2/authorize?${query}`;
}

/** A JWT's payload and header, unverified. */
export function decode(jwt: string) {
  const [header, payload] = jwt
    .split(".")
    .slice(0, 2)
    .map((part) => JSON.parse(Buffer.from(part!, "base64url").toString()));
  return { header, payload };
}

/** The identifiers of the provider's resource rows, sorted. */
export const resourceRows = async (pool: Pool) =>
  (await pool.query<{ identifier: string }>("SELECT identifier FROM better_auth_staff.oauth_resource")).rows
    .map((row) => row.identifier)
    .toSorted();

/** Who signs in, where: the login's origin, a declared email, the codes its sender kept, and the requests to it. */
export interface Flow {
  origin: string;
  email: string;
  codes: Map<string, string>;
  request: ReturnType<typeof requestsTo>;
}

/** Signs the person in on the page the provider sent them to (`page`), every request on `host`, and answers where it sends them next. */
export async function signInFrom(
  { origin, email, codes, request }: Flow,
  login: LoginHalf,
  page: string,
  host?: string,
): Promise<{ cookie: string; next: string }> {
  const { search } = new URL(page, origin);
  await login.handle(
    request("/auth/better-auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" }, host }),
  );
  const signed = (await login.handle(
    request("/auth/better-auth/sign-in/email-otp", {
      body: { email, otp: codes.get(email)!, oauth_query: search.slice(1) },
      host,
    }),
  ))!;
  expect(signed.status).toBe(200);
  const { url } = (await signed.json()) as { url?: string };
  return { cookie: cookieOf(signed), next: url! };
}

/** Allows the client on the consent page (`page`), and answers the client's redirect with its code. */
export async function consent(
  { origin, request }: Flow,
  login: LoginHalf,
  page: string,
  cookie: string,
  host?: string,
): Promise<URL> {
  const { search } = new URL(page, origin);
  const allowed = (await login.handle(
    request("/auth/better-auth/oauth2/consent", {
      body: { accept: true, oauth_query: search.slice(1) },
      cookie,
      host,
    }),
  ))!;
  expect(allowed.status).toBe(200);
  return new URL(((await allowed.json()) as { url: string }).url);
}

/** The token endpoint, as a client calls it: a form, no Origin, no cookie; `headers` besides, when it sends any. */
export async function token(
  { request }: Flow,
  login: LoginHalf,
  form: Record<string, string>,
  { headers = {}, host }: { headers?: Record<string, string>; host?: string } = {},
) {
  const asking = request("/auth/better-auth/oauth2/token", { form, origin: null, host });
  for (const [name, value] of Object.entries(headers)) asking.headers.set(name, value);
  const answered = (await login.handle(asking))!;
  return { status: answered.status, body: (await answered.json()) as Record<string, string> };
}

/**
 * The whole flow for `client` at `login`, every request on `host`: authorize for `resource`, sign
 * in by code, consent (when asked), the code for tokens.
 */
export async function connect(
  flow: Flow,
  login: LoginHalf,
  {
    client,
    resource,
    redirect = REDIRECT,
    host,
  }: { client: string; resource: string; redirect?: string; host?: string },
) {
  const { verifier, challenge } = pkce();
  const asked = (await login.handle(
    flow.request(authorizePath(client, challenge, resource, { redirect_uri: redirect }), { host }),
  ))!;
  expect(asked.status).toBe(302);
  const { cookie, next } = await signInFrom(flow, login, asked.headers.get("location")!, host);
  const back = next.startsWith(redirect) ? new URL(next) : await consent(flow, login, next, cookie, host);
  const form = {
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    redirect_uri: redirect,
    client_id: client,
    code_verifier: verifier,
    resource,
  };
  return { cookie, back, ...(await token(flow, login, form, { host })) };
}
