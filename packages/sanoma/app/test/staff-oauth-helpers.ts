import { createHash, randomBytes } from "node:crypto";
import { get } from "node:http";
import { Client } from "pg";
import { BUILT_IN_CLIENTS } from "sanoma/workflows/shared";

// What the tests of a client's sign-in on a host share (`hosted-mcp.test.ts` and
// `agent-router.test.ts` on Node, `app-bundle.test.ts` on the Worker): Claude Code's client as a
// stand-in serves it, a session's cookie, the staff login's schema afresh, and a client's
// sign-in step by step, each step given the base URL of the app it is on: the authorization
// request, the browser's navigation, a page's post, the sign-in by code, the consent, the token
// endpoint's forms and an MCP call's request and answer.

/**
 * The built-in clients' published ids, each the URL of its metadata document (`BUILT_IN_CLIENTS`):
 * `CLAUDE`, the client of Claude's hosted apps, and `CLAUDE_CODE`, Claude Code's.
 */
export const [CLAUDE, CLAUDE_CODE] = BUILT_IN_CLIENTS.map((b) => b.client) as [string, string];

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
 * The staff login's tables gone, with their journal, for `prepareBetterAuthStaff` to make afresh:
 * a consent an earlier run gave would skip the consent page.
 */
export async function resetStaffSchema(databaseUrl: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await db.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth_staff");
  await db.end();
}

/** A redirect on the person's own computer, as Claude Code's. */
export const REDIRECT = "http://127.0.0.1:53682/callback";

/** The authorization request a client opens in the browser for `resource`: its query, and the PKCE verifier it keeps. */
export function authorizeQuery(client: string, resource: string, state = "s1") {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    resource,
  });
  return { verifier, query };
}

/**
 * The browser the client opens on `url`: a navigation, answered with a redirect, never followed
 * here. Node's `fetch` says `Sec-Fetch-Mode: cors` whatever it is given, which a provider answers
 * with JSON instead: `node:http` says what a browser's navigation says.
 */
export function navigate(url: string, cookie?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { accept: "text/html", "sec-fetch-mode": "navigate", ...(cookie && { cookie }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers))
          if (typeof value === "string") headers.set(name, value);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    }).on("error", reject);
  });
}

/** A page's change on the app at `base`, from that app's own origin, as its sign-in and consent pages post. */
export const fromPageAt = (base: string, path: string, body: unknown, cookie?: string) =>
  fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(base).origin, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
  });

/**
 * Signs `email` in by code on the app at `base`, as its sign-in page does with the signed request
 * the provider sent it (`oauthQuery`): the code mailed (`codes`, what the login's sender kept),
 * then posted. Answers the session's cookie and where the login sends the person next.
 */
export async function signInByCode(base: string, email: string, codes: Map<string, string>, oauthQuery: string) {
  const sent = await fromPageAt(base, "/auth/better-auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  const signed = await fromPageAt(base, "/auth/better-auth/sign-in/email-otp", {
    email,
    otp: codes.get(email),
    oauth_query: oauthQuery,
  });
  const status = signed.status;
  const cookie = cookieOf(signed);
  const { url } = (await signed.json()) as { url?: string };
  return { sent: sent.status, status, cookie, next: new URL(url ?? "/", base) };
}

/**
 * The consent page at `consentAt` on the app at `base`, read and then allowed, as the person
 * signed in with `cookie`: the page's answer, and the client's redirect with its code.
 */
export async function allowAt(base: string, consentAt: URL, cookie: string) {
  const page = await fetch(consentAt, { headers: { cookie } });
  const consentPage = await page.text();
  const allowed = await fromPageAt(
    base,
    "/auth/better-auth/oauth2/consent",
    { accept: true, oauth_query: consentAt.search.slice(1) },
    cookie,
  );
  return { page, consentPage, back: new URL(((await allowed.json()) as { url: string }).url) };
}

/** The token endpoint's form for a code and its PKCE verifier, as `client` (Claude Code unless said) sends it. */
export const codeForm = (code: string, verifier: string, resource: string, client = CLAUDE_CODE) => ({
  grant_type: "authorization_code",
  code,
  redirect_uri: REDIRECT,
  client_id: client,
  code_verifier: verifier,
  resource,
});

/** The token endpoint's form for a refresh, as Claude Code sends it. */
export const refreshForm = (refresh_token: string, resource: string) => ({
  grant_type: "refresh_token",
  refresh_token,
  client_id: CLAUDE_CODE,
  resource,
});

/** A form posted to `url` as a client posts one: no Origin, no cookie. */
export const postForm = (url: string | URL, fields: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

/** A JSON-RPC request as an MCP client sends it to `/mcp`: its headers (no Origin) and its body. */
export const rpc = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

/** An MCP answer read: its JSON, or the last event of its stream. */
export function rpcAnswer(status: number, headers: Headers, text: string) {
  const data = headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .at(-1)
        ?.slice("data:".length)
    : text;
  return { status, headers, body: data ? JSON.parse(data) : undefined };
}
