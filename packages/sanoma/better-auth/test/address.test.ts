import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { type AgentAddress, CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareBetterAuthStaff } from "../src/instance.ts";
import { declaredMetadataFetch } from "../src/oauth.ts";
import { betterAuthStaffLogin } from "../src/staff.ts";
import { CLAUDE_CODE, CLAUDE_CODE_DOCUMENT, cookieOf, resetStaffSchema } from "./staff-helpers.ts";

// The instance's one configured agent address (`LoginContext.staff.oauth.address`): the issuer and
// the resource are what the app configured, whatever Host a request names. The resource's row is
// the provider's seed, there before any authorize and made by no request; the documents and the
// tokens name the configured pair alone; and with no address the login serves no OAuth.

const databaseUrl = testDatabaseUrl("better_auth_address");
const key = Buffer.from(hkdfSync("sha256", process.env.SANOMA_SIGNING_KEY!, "", "login staff", 32)).toString("hex");
const HOST = "company.example";
const ORIGIN = `https://${HOST}`;
const ADDRESS: AgentAddress = { issuer: `${ORIGIN}/auth/better-auth`, resource: `${ORIGIN}/mcp` };
/** A host nobody configured: what a request may say all the same. */
const MADE_UP = "made-up.example";
const DECLARED = "alice@example.com";
const REDIRECT = "http://localhost:53682/callback";

const codes = new Map<string, string>();
const pool = new Pool({ connectionString: databaseUrl });
const network = async (input: string | URL | Request): Promise<Response> =>
  String(input instanceof Request ? input.url : input) === CLAUDE_CODE
    ? Response.json(CLAUDE_CODE_DOCUMENT)
    : new Response("Not found", { status: 404 });
const agentOf = (client: string) => (client === CLAUDE_CODE ? "claude-code" : undefined);
/** The login with `address` as its agent address, or with none. */
const loginAt = (address: AgentAddress | undefined): LoginHalf => {
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
      ...(address && { oauth: { address, agentOf } }),
    },
  };
  return betterAuthStaffLogin(context, { fetchClientMetadata: declaredMetadataFetch(network) });
};

let nextIp = 1;
/** A request to the login through TLS, on its host unless `host` says another: a page's own unless `origin` is null (a client's). */
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
  const headers = new Headers({ host, "x-forwarded-proto": "https", [CLIENT_IP_HEADER]: `10.4.0.${nextIp++}` });
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

/** The authorization request a client opens in the browser, for `resource`. */
function authorizePath(challenge: string, resource: string) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLAUDE_CODE,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "offline_access",
    resource,
  });
  return `/auth/better-auth/oauth2/authorize?${query}`;
}

/** A JWT's payload, unverified. */
const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

/** The identifiers of the provider's resource rows, sorted. */
const resourceRows = async () =>
  (await pool.query<{ identifier: string }>("SELECT identifier FROM better_auth_staff.oauth_resource")).rows
    .map((row) => row.identifier)
    .toSorted();

/** The whole flow for Claude Code at `login`, every request on `host`: authorize, sign in by code, consent, the code for tokens. */
async function connect(login: LoginHalf, address: AgentAddress, host = HOST) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const asked = (await login.handle(request(authorizePath(challenge, address.resource), { host })))!;
  expect(asked.status).toBe(302);
  const { search } = new URL(asked.headers.get("location")!, ORIGIN);
  await login.handle(
    request("/auth/better-auth/email-otp/send-verification-otp", {
      body: { email: DECLARED, type: "sign-in" },
      host,
    }),
  );
  const signed = (await login.handle(
    request("/auth/better-auth/sign-in/email-otp", {
      body: { email: DECLARED, otp: codes.get(DECLARED)!, oauth_query: search.slice(1) },
      host,
    }),
  ))!;
  expect(signed.status).toBe(200);
  const cookie = cookieOf(signed);
  const consentAt = new URL(((await signed.json()) as { url: string }).url, ORIGIN);
  const allowed = (await login.handle(
    request("/auth/better-auth/oauth2/consent", {
      body: { accept: true, oauth_query: consentAt.search.slice(1) },
      cookie,
      host,
    }),
  ))!;
  expect(allowed.status).toBe(200);
  const back = new URL(((await allowed.json()) as { url: string }).url);
  const exchanged = (await login.handle(
    request("/auth/better-auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: CLAUDE_CODE,
        code_verifier: verifier,
        resource: address.resource,
      },
      origin: null,
      host,
    }),
  ))!;
  expect(exchanged.status).toBe(200);
  return { back, ...((await exchanged.json()) as { access_token: string; refresh_token: string }) };
}

beforeAll(async () => {
  await resetStaffSchema(databaseUrl);
  await prepareBetterAuthStaff(databaseUrl);
});

afterAll(() => pool.end());

describe("a login with no agent address", () => {
  it("serves no OAuth route and no discovery document, and seeds no resource", async () => {
    const plain = loginAt(undefined);
    // The login itself answers, so its instance has started.
    expect((await plain.handle(request("/auth/better-auth/get-session", { origin: null })))?.status).toBe(200);
    const challenge = "c".repeat(43);
    for (const asking of [
      request(authorizePath(challenge, ADDRESS.resource)),
      request("/auth/better-auth/oauth2/token", { form: { grant_type: "refresh_token" }, origin: null }),
      request("/auth/better-auth/oauth2/revoke", { form: { token: "nothing" }, origin: null }),
      request("/auth/better-auth/oauth2/consent", { body: { accept: true } }),
      request("/auth/better-auth/jwks", { origin: null }),
      request("/auth/better-auth/error?error=x", { origin: null }),
      request("/.well-known/oauth-protected-resource/mcp", { origin: null }),
      request("/.well-known/oauth-protected-resource", { origin: null }),
      request("/.well-known/oauth-authorization-server/auth/better-auth", { origin: null }),
      request("/.well-known/oauth-authorization-server", { origin: null }),
    ]) {
      expect((await plain.handle(asking))?.status, asking.url).toBe(404);
    }
    expect(plain.bearer).toBeUndefined();
    expect(await resourceRows()).toEqual([]);
  });
});

describe("an agent address", () => {
  it("is refused when a token could never match it: a trailing slash, a query, a host not as it is compared", () => {
    for (const [part, written] of [
      ["issuer", `${ADDRESS.issuer}/`],
      ["issuer", "https://mcp.router.example/"],
      ["issuer", "https://Company.Example/auth/better-auth"],
      ["issuer", "https://company.example:443/auth/better-auth"],
      ["issuer", "company.example/auth/better-auth"],
      ["resource", `${ADDRESS.resource}/`],
      ["resource", `${ADDRESS.resource}?x=1`],
      ["resource", `${ADDRESS.resource}#x`],
      ["resource", "/mcp"],
    ] as const) {
      expect(() => loginAt({ ...ADDRESS, [part]: written }), written).toThrow(
        `better-auth: the agent address's ${part} is ${JSON.stringify(written)}`,
      );
    }
    // An issuer at its origin's root, and one on a port, are good as written.
    for (const issuer of ["https://mcp.router.example", "http://127.0.0.1:3000/auth/better-auth"]) {
      expect(() => loginAt({ ...ADDRESS, issuer }), issuer).not.toThrow();
    }
  });
});

describe("a login with an agent address", () => {
  let half: LoginHalf;
  beforeAll(() => {
    half = loginAt(ADDRESS);
  });

  it("has its resource's row before any authorize: the provider's seed, at the login's first request", async () => {
    expect(await resourceRows()).toEqual([]);
    expect((await half.handle(request("/auth/better-auth/get-session", { origin: null })))?.status).toBe(200);
    expect(await resourceRows()).toEqual([ADDRESS.resource]);
  });

  it("makes no row and no document for a made-up Host", async () => {
    const madeUp = `https://${MADE_UP}/mcp`;
    // A declared client asking for the made-up host's own /mcp, on that host: refused, on a page.
    const asked = (await half.handle(request(authorizePath("c".repeat(43), madeUp), { host: MADE_UP })))!;
    expect(asked.status).toBe(400);
    expect(await asked.text()).toContain(ADDRESS.resource);
    // The token endpoint, which needs no sign-in, has no row for it either.
    const junk = (await half.handle(
      request("/auth/better-auth/oauth2/token", {
        form: { grant_type: "refresh_token", refresh_token: "nothing", client_id: CLAUDE_CODE, resource: madeUp },
        origin: null,
        host: MADE_UP,
      }),
    ))!;
    expect(junk.status).toBe(400);
    expect(await resourceRows()).toEqual([ADDRESS.resource]);
    // The documents are the configured address's on any Host: none names the host asked.
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/auth/better-auth",
    ]) {
      const answered = (await half.handle(request(path, { origin: null, host: MADE_UP })))!;
      expect(answered.status, path).toBe(200);
      expect(answered.headers.has("vary"), path).toBe(false);
      const text = await answered.text();
      expect(text, path).not.toContain(MADE_UP);
      expect(text, path).toContain(ADDRESS.issuer);
    }
    const resource = (await half.handle(
      request("/.well-known/oauth-protected-resource/mcp", { origin: null, host: MADE_UP }),
    ))!;
    expect(await resource.json()).toEqual({
      resource: ADDRESS.resource,
      authorization_servers: [ADDRESS.issuer],
      bearer_methods_supported: ["header"],
    });
  });

  it("issues for the configured issuer and resource on any Host, and takes the token at /mcp on any Host", async () => {
    const { access_token, back } = await connect(half, ADDRESS, MADE_UP);
    expect(back.searchParams.get("iss")).toBe(ADDRESS.issuer);
    expect(claimsOf(access_token)).toMatchObject({ iss: ADDRESS.issuer, aud: ADDRESS.resource, azp: CLAUDE_CODE });
    for (const host of [HOST, MADE_UP, "10.0.0.7:3000"]) {
      expect(await half.bearer!(request("/mcp", { origin: null, bearer: access_token, host })), host).toMatchObject({
        email: DECLARED,
        client: CLAUDE_CODE,
      });
    }
    expect(await resourceRows()).toEqual([ADDRESS.resource]);
  });

  it("refuses a token issued for another address, though the same keys signed it", async () => {
    // Another login on the same tables and keys, its address a router's: its tokens are that address's.
    const router: AgentAddress = { issuer: "https://mcp.router.example", resource: "https://mcp.router.example/mcp" };
    const routed = loginAt(router);
    const theirs = await connect(routed, router);
    expect(claimsOf(theirs.access_token)).toMatchObject({ iss: router.issuer, aud: router.resource });
    expect(await routed.bearer!(request("/mcp", { origin: null, bearer: theirs.access_token }))).toMatchObject({
      client: CLAUDE_CODE,
    });
    const ours = await connect(half, ADDRESS);
    // Each refuses the other's, on its own host, the other's, and the host the token names.
    for (const host of [HOST, "mcp.router.example"]) {
      expect(await half.bearer!(request("/mcp", { origin: null, bearer: theirs.access_token, host })), host).toBeNull();
      expect(await routed.bearer!(request("/mcp", { origin: null, bearer: ours.access_token, host })), host).toBeNull();
    }
    // A token of one's issuer for the other's resource is none either: both must be the configured pair.
    const mixed = loginAt({ issuer: ADDRESS.issuer, resource: router.resource });
    const split = await connect(mixed, { issuer: ADDRESS.issuer, resource: router.resource });
    expect(claimsOf(split.access_token)).toMatchObject({ iss: ADDRESS.issuer, aud: router.resource });
    expect(await half.bearer!(request("/mcp", { origin: null, bearer: split.access_token }))).toBeNull();
    expect(await routed.bearer!(request("/mcp", { origin: null, bearer: split.access_token }))).toBeNull();
  });
});
