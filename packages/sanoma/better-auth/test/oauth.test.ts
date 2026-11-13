import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareBetterAuthStaff } from "../src/instance.ts";
import { declaredMetadataFetch } from "../src/oauth.ts";
import { betterAuthStaffLogin } from "../src/staff.ts";

// The staff login as the agent surface's authorization server: its metadata, a declared client's
// sign-in by email code with PKCE, consent and a JWT for the instance's own `/mcp`, the token
// endpoint taking a form with no Origin, an undeclared client refused before its document is
// fetched, and the bearer checked for its issuer, audience, signature and expiry. Claude Code's
// client metadata document is served by a stand-in for claude.ai: nothing here leaves the machine.

const databaseUrl = testDatabaseUrl("better_auth_oauth");
const key = Buffer.from(hkdfSync("sha256", process.env.SANOMA_SIGNING_KEY!, "", "login staff", 32)).toString("hex");
const HOST = "company.example";
const ORIGIN = `https://${HOST}`;
const MCP = `${ORIGIN}/mcp`;
const ISSUER = `${ORIGIN}/auth/better-auth`;
const DECLARED = "alice@example.com";
/** Claude Code's published client id: the URL of its metadata document. */
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
/** Another client's, which no agent declares. */
const UNDECLARED = "https://elsewhere.example/oauth/client.json";
const REDIRECT = "http://localhost:53682/callback";

/** Claude Code's document, as claude.ai serves it. */
const DOCUMENT = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** Each document fetched, by URL, and how it was asked to treat a redirect: the stand-in for the network the CIMD plugin reaches. */
const fetched: string[] = [];
const redirects = new Set<RequestInit["redirect"]>();
async function network(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  redirects.add(init?.redirect);
  if (url === CLAUDE_CODE) return Response.json(DOCUMENT, { headers: { "cache-control": "max-age=3600" } });
  if (url === "https://claude.ai/oauth/moved")
    return new Response(null, { status: 302, headers: { location: CLAUDE_CODE } });
  return new Response("Not found", { status: 404 });
}

/** Which agent stands for which client, as the people files say: changed by a test to undeclare one. */
const agents = new Map([
  [CLAUDE_CODE, "claude-code"],
  ["https://claude.ai/oauth/moved", "moved"],
]);
const codes = new Map<string, string>();
const pool = new Pool({ connectionString: databaseUrl });
const context: LoginContext = {
  database: async () => pool,
  key,
  secrets: async () => new Map(),
  origins: [],
  sendCode: async (email, code) => void codes.set(email, code),
  staff: {
    admits: ({ email }) => email?.toLowerCase() === DECLARED,
    social: {},
    record: async () => undefined,
    oauth: { resource: "/mcp", agentOf: (client) => agents.get(client) },
  },
};
let half: LoginHalf;

let nextIp = 1;
/** A request to the login on its host, through TLS: from the page's own origin unless `origin` is null (a client's). */
function request(
  path: string,
  init: {
    body?: unknown;
    form?: Record<string, string>;
    cookie?: string;
    origin?: string | null;
    bearer?: string;
    host?: string;
  } = {},
): Request {
  const host = init.host ?? HOST;
  const headers = new Headers({ host, "x-forwarded-proto": "https", [CLIENT_IP_HEADER]: `10.2.0.${nextIp++}` });
  if (init.origin !== null) headers.set("origin", init.origin ?? `https://${host}`);
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
  return new Request(`http://${host}${path}`, { method: body === undefined ? "GET" : "POST", headers, body });
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/** A PKCE pair: the verifier, and its S256 challenge. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The authorization request a client opens in the browser. */
function authorizePath(client: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "offline_access",
    resource: MCP,
    ...extra,
  });
  return `/auth/better-auth/oauth2/authorize?${query}`;
}

/** A JWT's payload and header, unverified. */
function decode(jwt: string) {
  const [header, payload] = jwt
    .split(".")
    .slice(0, 2)
    .map((part) => JSON.parse(Buffer.from(part!, "base64url").toString()));
  return { header, payload };
}

/** Signs Alice in on the page the provider sent her to, and answers where it sends her next. */
async function signInFrom(login: string): Promise<{ cookie: string; next: string }> {
  const { search } = new URL(login, ORIGIN);
  await half.handle(
    request("/auth/better-auth/email-otp/send-verification-otp", { body: { email: DECLARED, type: "sign-in" } }),
  );
  const signed = (await half.handle(
    request("/auth/better-auth/sign-in/email-otp", {
      body: { email: DECLARED, otp: codes.get(DECLARED)!, oauth_query: search.slice(1) },
    }),
  ))!;
  expect(signed.status).toBe(200);
  const { url } = (await signed.json()) as { url?: string };
  return { cookie: cookieOf(signed), next: url! };
}

/** Allows the client on the consent page, and answers the client's redirect with its code. */
async function consent(page: string, cookie: string): Promise<URL> {
  const { search } = new URL(page, ORIGIN);
  const allowed = (await half.handle(
    request("/auth/better-auth/oauth2/consent", { body: { accept: true, oauth_query: search.slice(1) }, cookie }),
  ))!;
  expect(allowed.status).toBe(200);
  return new URL(((await allowed.json()) as { url: string }).url);
}

/** The token endpoint, as a client calls it: a form, no Origin, no cookie. */
async function token(form: Record<string, string>) {
  const answered = (await half.handle(request("/auth/better-auth/oauth2/token", { form, origin: null })))!;
  return { status: answered.status, body: (await answered.json()) as Record<string, string> };
}

/** The whole flow for Claude Code: authorize, sign in by code, consent, the code for tokens. */
async function connect() {
  const { verifier, challenge } = pkce();
  const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge))))!;
  expect(asked.status).toBe(302);
  const login = asked.headers.get("location")!;
  const { cookie, next } = await signInFrom(login);
  const back = next.startsWith(REDIRECT) ? new URL(next) : await consent(next, cookie);
  const code = back.searchParams.get("code")!;
  return {
    cookie,
    back,
    ...(await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLAUDE_CODE,
      code_verifier: verifier,
      resource: MCP,
    })),
  };
}

beforeAll(async () => {
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
  await prepareBetterAuthStaff(databaseUrl);
  half = betterAuthStaffLogin(context, { fetchClientMetadata: declaredMetadataFetch(network) });
});

afterAll(() => pool.end());

describe("the staff login's discovery", () => {
  it("serves the agent surface's protected resource metadata, naming the login as its authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const answered = (await half.handle(request(path, { origin: null })))!;
      expect(answered.status, path).toBe(200);
      expect(await answered.json(), path).toMatchObject({ resource: MCP, authorization_servers: [ISSUER] });
    }
  });

  it("serves its authorization server metadata where RFC 8414 puts it for its issuer: CIMD, public clients and S256", async () => {
    const answered = (await half.handle(
      request("/.well-known/oauth-authorization-server/auth/better-auth", { origin: null }),
    ))!;
    expect(answered.status).toBe(200);
    const metadata = (await answered.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  it("serves no metadata without the app's OAuth context", async () => {
    const plain = betterAuthStaffLogin({ ...context, staff: { ...context.staff!, oauth: undefined } });
    expect(await plain.handle(request("/.well-known/oauth-protected-resource/mcp", { origin: null }))).toBeUndefined();
  });
});

describe("a declared client", () => {
  it("signs a person in by email code, asks their consent, and gets a JWT for the instance's own /mcp", async () => {
    const { status, body, back } = await connect();
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("state-1");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    expect(status).toBe(200);
    expect(body.token_type).toMatch(/^bearer$/i);
    expect(body.refresh_token).toEqual(expect.any(String));
    const { header, payload } = decode(body.access_token!);
    expect(header.typ).toBe("at+jwt");
    expect(payload).toMatchObject({ aud: MCP, iss: ISSUER, azp: CLAUDE_CODE, scope: "offline_access" });
    expect(fetched).toEqual([CLAUDE_CODE]);
    expect([...redirects]).toEqual(["manual"]);
  });

  it("says who a bearer is for, and which client it was issued to", async () => {
    const { body } = await connect();
    expect(await half.bearer!(request("/mcp", { bearer: body.access_token, origin: null }))).toEqual({
      subject: expect.any(String),
      email: DECLARED,
      client: CLAUDE_CODE,
    });
  });

  it("asks no consent the second time, and rotates the refresh token", async () => {
    const first = await connect();
    const again = await connect();
    expect(again.status).toBe(200);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token!,
      client_id: CLAUDE_CODE,
      resource: MCP,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(decode(refreshed.body.access_token!).payload.aud).toBe(MCP);
  });

  it("is refused a resource that is not this instance's own /mcp", async () => {
    const { challenge } = pkce();
    for (const resource of ["https://elsewhere.example/mcp", `${ORIGIN}/api/call`]) {
      const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge, { resource }))))!;
      expect(asked.status, resource).toBe(400);
      expect(await asked.text(), resource).toContain(MCP);
    }
  });

  it("is refused once no agent declares it any more: at authorize, and at the token endpoint", async () => {
    const { body } = await connect();
    agents.delete(CLAUDE_CODE);
    try {
      const { challenge } = pkce();
      const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge))))!;
      expect(asked.status).toBe(403);
      const refreshed = await token({
        grant_type: "refresh_token",
        refresh_token: body.refresh_token!,
        client_id: CLAUDE_CODE,
        resource: MCP,
      });
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe("invalid_client");
    } finally {
      agents.set(CLAUDE_CODE, "claude-code");
    }
  });
});

describe("an undeclared client", () => {
  it("is refused at authorize with what to declare, before its document is fetched", async () => {
    fetched.length = 0;
    const { challenge } = pkce();
    const asked = (await half.handle(request(authorizePath(UNDECLARED, challenge))))!;
    expect(asked.status).toBe(403);
    const page = await asked.text();
    expect(page).toContain("resources/people.ts");
    expect(page).toContain(`client: &quot;${UNDECLARED}&quot;`);
    expect(fetched).toEqual([]);
  });

  it("whose declared document redirects is refused, the redirect not followed", async () => {
    fetched.length = 0;
    const { challenge } = pkce();
    const asked = (await half.handle(request(authorizePath("https://claude.ai/oauth/moved", challenge))))!;
    expect(asked.status).not.toBe(302);
    expect(fetched).toEqual(["https://claude.ai/oauth/moved"]);
  });
});

describe("the same-origin rule", () => {
  it("takes the token endpoint's form with no Origin, and no other change", async () => {
    // No Origin on a sign-in, a consent or a code: refused before Better Auth.
    for (const [path, body] of [
      ["/auth/better-auth/sign-in/email-otp", { email: DECLARED, otp: "000000" }],
      ["/auth/better-auth/oauth2/consent", { accept: true }],
      ["/auth/better-auth/email-otp/send-verification-otp", { email: DECLARED, type: "sign-in" }],
    ] as const) {
      expect((await half.handle(request(path, { body, origin: null })))?.status, path).toBe(403);
    }
    // The token endpoint's form with none: Better Auth's answer, not the rule's.
    const { status, body } = await token({ grant_type: "authorization_code", code: "nothing", client_id: CLAUDE_CODE });
    expect(status).not.toBe(403);
    expect(body.error).toEqual(expect.any(String));
  });

  it("serves authorize to a GET alone", async () => {
    const { challenge } = pkce();
    const posted = await half.handle(
      new Request(`http://${HOST}${authorizePath(CLAUDE_CODE, challenge)}`, {
        method: "POST",
        headers: { host: HOST, origin: ORIGIN, "x-forwarded-proto": "https" },
      }),
    );
    expect(posted?.status).toBe(405);
  });
});

describe("a bearer", () => {
  it("is refused for another audience, another issuer, a bad signature or once expired", async () => {
    const { body } = await connect();
    const access = body.access_token!;
    // The same instance's token, for /mcp on another host: neither the audience nor the issuer there.
    expect(await half.bearer!(request("/mcp", { bearer: access, origin: null, host: "other.example" }))).toBeNull();
    // A token another resource of this login was issued for: the same issuer and keys, another audience.
    const other = betterAuthStaffLogin(
      { ...context, staff: { ...context.staff!, oauth: { ...context.staff!.oauth!, resource: "/elsewhere" } } },
      { fetchClientMetadata: declaredMetadataFetch(network) },
    );
    expect(decode(access).payload.aud).toBe(MCP);
    expect(await other.bearer!(request("/elsewhere", { bearer: access, origin: null }))).toBeNull();
    // One character of the signature changed.
    const [head, payload, signature] = access.split(".");
    const flipped = `${head}.${payload}.${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    expect(await half.bearer!(request("/mcp", { bearer: flipped, origin: null }))).toBeNull();
    // Not a JWT, and no bearer at all.
    expect(await half.bearer!(request("/mcp", { bearer: "sca_nothing", origin: null }))).toBeNull();
    expect(await half.bearer!(request("/mcp", { origin: null }))).toBeNull();
    // An hour on, the token has expired.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      expect(await half.bearer!(request("/mcp", { bearer: access, origin: null }))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(await half.bearer!(request("/mcp", { bearer: access, origin: null }))).toMatchObject({
      client: CLAUDE_CODE,
    });
  });
});
