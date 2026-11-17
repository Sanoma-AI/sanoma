import { hkdfSync } from "node:crypto";
import type { AgentAddress, LoginContext, LoginHalf } from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareBetterAuthStaff } from "../src/instance.ts";
import { declaredMetadataFetch } from "../src/oauth.ts";
import { betterAuthStaffLogin } from "../src/staff.ts";
import {
  authorizePath,
  CLAUDE_CODE,
  CLAUDE_CODE_DOCUMENT,
  connect as connectAt,
  decode,
  type Flow,
  requestsTo,
  resetStaffSchema,
  resourceRows as rowsOf,
} from "./staff-helpers.ts";

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

const request = requestsTo(HOST, "10.4.0");
const flow: Flow = { origin: ORIGIN, email: DECLARED, codes, request };
/** A JWT's payload, unverified. */
const claimsOf = (jwt: string) => decode(jwt).payload as Record<string, unknown>;
/** The whole flow for Claude Code at `login`, for `address`'s resource, every request on `host`. */
const connect = (login: LoginHalf, address: AgentAddress, host?: string) =>
  connectAt(flow, login, { client: CLAUDE_CODE, resource: address.resource, host });
/** A token as `connect` answers it. */
const accessOf = ({ status, body }: Awaited<ReturnType<typeof connect>>) => {
  expect(status).toBe(200);
  return body.access_token!;
};

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
      request(authorizePath(CLAUDE_CODE, challenge, ADDRESS.resource)),
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
    expect(await rowsOf(pool)).toEqual([]);
  });
});

describe("an agent address", () => {
  it("is refused when a token could never match it: a trailing slash, a query, a host not as it is compared", () => {
    for (const [part, written] of [
      ["issuer", `${ADDRESS.issuer}/`],
      ["issuer", "https://Company.Example/auth/better-auth"],
      ["issuer", "https://company.example:443/auth/better-auth"],
      ["issuer", "https://ada@company.example/auth/better-auth"],
      ["issuer", "company.example/auth/better-auth"],
      ["resource", `${ADDRESS.resource}/`],
      ["resource", `${ADDRESS.resource}?x=1`],
      ["resource", `${ADDRESS.resource}#x`],
      ["resource", "/mcp"],
    ] as const) {
      expect(() => loginAt({ ...ADDRESS, [part]: written }), written).toThrow(
        `better-auth: the agent address's ${part} is ${JSON.stringify(written)}: write an http(s) URL as it is compared`,
      );
    }
  });

  it("is refused when the login could not serve it: an issuer elsewhere than its own routes, a resource at a root", () => {
    // The login's routes are at /auth/better-auth alone: an issuer at a root, or another path, would name endpoints that 404.
    for (const issuer of ["https://mcp.router.example", `${ORIGIN}/auth`, `${ORIGIN}/auth/better-auth/v2`]) {
      expect(() => loginAt({ ...ADDRESS, issuer }), issuer).toThrow(
        /^better-auth: the agent address's issuer is .*: its path must be \/auth\/better-auth.*sanoma#777/,
      );
    }
    expect(() => loginAt({ ...ADDRESS, resource: ORIGIN })).toThrow(
      /^better-auth: the agent address's resource is .*: it needs a path.*sanoma#777/,
    );
    // An address on a port, over plain http, is good as written.
    const local = { issuer: "http://127.0.0.1:3000/auth/better-auth", resource: "http://127.0.0.1:3000/mcp" };
    expect(() => loginAt(local)).not.toThrow();
  });
});

describe("a login with an agent address", () => {
  let half: LoginHalf;
  beforeAll(() => {
    half = loginAt(ADDRESS);
  });

  it("has its resource's row before any authorize: made at the login's first request, whatever it asks", async () => {
    expect(await rowsOf(pool)).toEqual([]);
    expect((await half.handle(request("/auth/better-auth/get-session", { origin: null })))?.status).toBe(200);
    expect(await rowsOf(pool)).toEqual([ADDRESS.resource]);
  });

  it("makes no row and no document for a made-up Host", async () => {
    const madeUp = `https://${MADE_UP}/mcp`;
    // A declared client asking for the made-up host's own /mcp, on that host: refused, on a page.
    const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, "c".repeat(43), madeUp), { host: MADE_UP })))!;
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
    expect(await rowsOf(pool)).toEqual([ADDRESS.resource]);
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
    const issued = await connect(half, ADDRESS, MADE_UP);
    const access = accessOf(issued);
    expect(issued.back.searchParams.get("iss")).toBe(ADDRESS.issuer);
    expect(claimsOf(access)).toMatchObject({ iss: ADDRESS.issuer, aud: ADDRESS.resource, azp: CLAUDE_CODE });
    for (const host of [HOST, MADE_UP, "10.0.0.7:3000"]) {
      expect(await half.bearer!(request("/mcp", { origin: null, bearer: access, host })), host).toMatchObject({
        email: DECLARED,
        client: CLAUDE_CODE,
      });
    }
    expect(await rowsOf(pool)).toEqual([ADDRESS.resource]);
  });

  it("refuses a token issued for another address, though the same keys signed it", async () => {
    // Another login on the same tables and keys, configured with another origin's address: its tokens are that address's.
    const OTHER = "https://other.example";
    const other: AgentAddress = { issuer: `${OTHER}/auth/better-auth`, resource: `${OTHER}/mcp` };
    const elsewhere = loginAt(other);
    const theirs = accessOf(await connect(elsewhere, other));
    expect(claimsOf(theirs)).toMatchObject({ iss: other.issuer, aud: other.resource });
    expect(await elsewhere.bearer!(request("/mcp", { origin: null, bearer: theirs }))).toMatchObject({
      client: CLAUDE_CODE,
    });
    const ours = accessOf(await connect(half, ADDRESS));
    // Each refuses the other's, on its own host and on the host the token names.
    for (const host of [HOST, "other.example"]) {
      expect(await half.bearer!(request("/mcp", { origin: null, bearer: theirs, host })), host).toBeNull();
      expect(await elsewhere.bearer!(request("/mcp", { origin: null, bearer: ours, host })), host).toBeNull();
    }
    // A token of one's issuer for the other's resource is none either: both must be the configured pair.
    const mixed = { issuer: ADDRESS.issuer, resource: other.resource };
    const split = accessOf(await connect(loginAt(mixed), mixed));
    expect(claimsOf(split)).toMatchObject({ iss: ADDRESS.issuer, aud: other.resource });
    expect(await half.bearer!(request("/mcp", { origin: null, bearer: split }))).toBeNull();
    expect(await elsewhere.bearer!(request("/mcp", { origin: null, bearer: split }))).toBeNull();
    // Each login made the row of its own resource, and no other.
    expect(await rowsOf(pool)).toEqual([ADDRESS.resource, other.resource].toSorted());
  });
});
