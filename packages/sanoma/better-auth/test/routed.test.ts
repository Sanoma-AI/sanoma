import { hkdfSync } from "node:crypto";
import {
  type AgentAddress,
  CLIENT_IP_HEADER,
  type LoginContext,
  type LoginHalf,
  ROUTER_CLIENT_IP_HEADER,
  ROUTER_SECRET_HEADER,
} from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareBetterAuthStaff } from "../src/instance.ts";
import { declaredMetadataFetch } from "../src/oauth.ts";
import { betterAuthStaffLogin, withRoutedCaller } from "../src/staff.ts";
import {
  authorizePath,
  CLAUDE_CODE,
  CLAUDE_CODE_DOCUMENT,
  connect as connectAt,
  consent,
  decode,
  type Flow,
  pkce,
  REDIRECT,
  requestsTo,
  resetStaffSchema,
  resourceRows,
  signInFrom,
  token,
} from "./staff-helpers.ts";

// An agent address on a router's host (`AgentAddress.router`, sanoma#777): the instance signs
// for the router's issuer and `/mcp`, names its company in the access token, and tags every code
// and refresh token with `<company>.`, going out and coming in. The browser's part (authorize,
// the sign-in, the consent) stays on the instance's own host; what the router forwards (the
// token endpoint, revocation, `/mcp`) reaches the login with the request's URL on that host.

const databaseUrl = testDatabaseUrl("better_auth_routed");
const key = Buffer.from(hkdfSync("sha256", process.env.SANOMA_SIGNING_KEY!, "", "login staff", 32)).toString("hex");
/** The instance's own host: where a person signs in, and what the router forwards to. */
const HOST = "acme.example";
const ORIGIN = `https://${HOST}`;
const ROUTER = "https://mcp.router.example";
const MCP = `${ROUTER}/mcp`;
const SECRET = "the-router's-secret";
const routed = (company: string): AgentAddress => ({
  issuer: ROUTER,
  resource: MCP,
  router: { company, secret: SECRET },
});
const ACME = routed("acme");
const DECLARED = "alice@example.com";
/** A declared client that is a site: a remembered consent sends its code straight from authorize. */
const WEB = "https://web.example/oauth/client.json";
const WEB_REDIRECT = "https://web.example/callback";

const codes = new Map<string, string>();
const pool = new Pool({ connectionString: databaseUrl });
const network = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === CLAUDE_CODE) return Response.json(CLAUDE_CODE_DOCUMENT);
  if (url === WEB) return Response.json({ ...CLAUDE_CODE_DOCUMENT, client_id: WEB, redirect_uris: [WEB_REDIRECT] });
  return new Response("Not found", { status: 404 });
};
const agents = new Map([
  [CLAUDE_CODE, "claude-code"],
  [WEB, "web-bot"],
]);
const loginAt = (address: AgentAddress): LoginHalf => {
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
      oauth: { address, agentOf: (client) => agents.get(client) },
    },
  };
  return betterAuthStaffLogin(context, { fetchClientMetadata: declaredMetadataFetch(network) });
};

const request = requestsTo(HOST, "10.7.0");
const flow: Flow = { origin: ORIGIN, email: DECLARED, codes, request };
const claimsOf = (jwt: string) => decode(jwt).payload as Record<string, unknown>;
const connect = (login: LoginHalf, client = CLAUDE_CODE, redirect = REDIRECT) =>
  connectAt(flow, login, { client, resource: MCP, redirect });
/** The code a client was sent back with, from authorize to the consent. */
async function codeFor(login: LoginHalf) {
  const { verifier, challenge } = pkce();
  const asked = (await login.handle(request(authorizePath(CLAUDE_CODE, challenge, MCP))))!;
  const { cookie, next } = await signInFrom(flow, login, asked.headers.get("location")!);
  const back = await consent(flow, login, next, cookie);
  return { code: back.searchParams.get("code")!, verifier, back };
}
const exchange = (login: LoginHalf, code: string, verifier: string, client = CLAUDE_CODE, redirect = REDIRECT) =>
  token(flow, login, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: client,
    code_verifier: verifier,
    resource: MCP,
  });
const refresh = (login: LoginHalf, refresh_token: string) =>
  token(flow, login, { grant_type: "refresh_token", refresh_token, client_id: CLAUDE_CODE, resource: MCP });
const revoke = async (login: LoginHalf, form: Record<string, string>) =>
  (await login.handle(request("/auth/better-auth/oauth2/revoke", { form, origin: null })))!.status;
const bearerOf = (login: LoginHalf, bearer: string, host?: string) =>
  login.bearer!(request("/mcp", { origin: null, bearer, host }));

let acme: LoginHalf;
beforeAll(async () => {
  await resetStaffSchema(databaseUrl);
  await prepareBetterAuthStaff(databaseUrl);
  acme = loginAt(ACME);
});
afterAll(() => pool.end());

describe("a login whose agent address is a router's", () => {
  it("issues as the router for the router's /mcp, names its company, and tags the code and the refresh token", async () => {
    const issued = await connect(acme);
    expect(issued.status).toBe(200);
    // The redirect back to the client: RFC 9207's `iss` is the router's, the code the company's.
    expect(issued.back.origin + issued.back.pathname).toBe(REDIRECT);
    expect(issued.back.searchParams.get("iss")).toBe(ROUTER);
    expect(issued.back.searchParams.get("state")).toBe("state-1");
    expect(issued.back.searchParams.get("code")).toMatch(/^acme\.[A-Za-z0-9]+$/);
    expect(issued.body.token_type).toBe("Bearer");
    expect(claimsOf(issued.body.access_token!)).toMatchObject({
      iss: ROUTER,
      aud: MCP,
      azp: CLAUDE_CODE,
      sanoma_agent: "claude-code",
      sanoma_company: "acme",
    });
    expect(issued.body.refresh_token).toMatch(/^acme\.[A-Za-z0-9]+$/);
    // The router forwards a /mcp call to the instance's own host; whichever Host it names, the token is good.
    for (const host of [HOST, "mcp.router.example"]) {
      expect(await bearerOf(acme, issued.body.access_token!, host), host).toMatchObject({
        email: DECLARED,
        client: CLAUDE_CODE,
      });
    }
    // Its one resource row is the router's /mcp.
    expect(await resourceRows(pool)).toEqual([MCP]);
  });

  it("serves no RFC 8414 document for the router's issuer, and RFC 9728's naming the router", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/auth/better-auth",
      "/.well-known/openid-configuration",
    ]) {
      expect((await acme.handle(request(path, { origin: null })))?.status, path).toBe(404);
    }
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const answered = (await acme.handle(request(path, { origin: null })))!;
      expect(answered.status, path).toBe(200);
      expect(await answered.json(), path).toEqual({
        resource: MCP,
        authorization_servers: [ROUTER],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("refuses an authorize for its own host's /mcp: the resource is the router's alone", async () => {
    const own = (await acme.handle(request(authorizePath(CLAUDE_CODE, "c".repeat(43), `${ORIGIN}/mcp`))))!;
    expect(own.status).toBe(400);
    expect(await own.text()).toContain(MCP);
  });

  it("refuses a code without its tag or with another company's, and spends none by it", async () => {
    const { code, verifier } = await codeFor(acme);
    const bare = code.slice("acme.".length);
    for (const wrong of [bare, `globex.${bare}`, `acme${bare}`, `.${bare}`, `ACME.${bare}`]) {
      expect(await exchange(acme, wrong, verifier), wrong).toMatchObject({
        status: 400,
        body: { error: "invalid_grant" },
      });
    }
    // None of them spent it: it is good once, then not again.
    expect((await exchange(acme, code, verifier)).status).toBe(200);
    expect(await exchange(acme, code, verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("takes a refresh token back only with its tag, rotates it tagged, and revokes it tagged", async () => {
    const issued = await connect(acme);
    const first = issued.body.refresh_token!;
    const bare = first.slice("acme.".length);
    for (const wrong of [bare, `globex.${bare}`]) {
      expect((await refresh(acme, wrong)).status, wrong).toBe(400);
    }
    // Neither spent it.
    const rotated = await refresh(acme, first);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).toMatch(/^acme\./);
    expect(rotated.body.refresh_token).not.toBe(first);
    expect(claimsOf(rotated.body.access_token!)).toMatchObject({ iss: ROUTER, aud: MCP, sanoma_company: "acme" });
    // Revocation without the tag ends nothing; with it, the token is refused after.
    const second = rotated.body.refresh_token!;
    await revoke(acme, { token: second.slice("acme.".length), client_id: CLAUDE_CODE });
    const third = await refresh(acme, second);
    expect(third.status).toBe(200);
    expect(await revoke(acme, { token: third.body.refresh_token!, client_id: CLAUDE_CODE })).toBe(200);
    expect((await refresh(acme, third.body.refresh_token!)).status).toBe(400);
  });

  it("tags the code on every answer that sends one: the consent, authorize's own redirect, and a sign-in's two shapes", async () => {
    // 1. The consent's JSON `url`, for a site's client.
    const first = await connect(acme, WEB, WEB_REDIRECT);
    expect(first.status).toBe(200);
    expect(first.back.searchParams.get("code")).toMatch(/^acme\./);

    // 2. Authorize itself, signed in and the consent remembered (an HTTPS redirect): a 302's Location.
    const two = pkce();
    const direct = (await acme.handle(
      request(authorizePath(WEB, two.challenge, MCP, { redirect_uri: WEB_REDIRECT }), { cookie: first.cookie }),
    ))!;
    expect(direct.status).toBe(302);
    const location = new URL(direct.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(WEB_REDIRECT);
    expect(location.searchParams.get("iss")).toBe(ROUTER);
    expect(location.searchParams.get("code")).toMatch(/^acme\./);
    expect((await exchange(acme, location.searchParams.get("code")!, two.verifier, WEB, WEB_REDIRECT)).status).toBe(
      200,
    );

    // 3. A sign-in a page posted with the signed request, the consent remembered: the JSON `url`.
    const three = pkce();
    const asked = (await acme.handle(
      request(authorizePath(WEB, three.challenge, MCP, { redirect_uri: WEB_REDIRECT })),
    ))!;
    const { next } = await signInFrom(flow, acme, asked.headers.get("location")!);
    expect(next.startsWith(WEB_REDIRECT)).toBe(true);
    const posted = new URL(next);
    expect(posted.searchParams.get("iss")).toBe(ROUTER);
    expect(posted.searchParams.get("code")).toMatch(/^acme\./);
    expect((await exchange(acme, posted.searchParams.get("code")!, three.verifier, WEB, WEB_REDIRECT)).status).toBe(
      200,
    );

    // 4. The same sign-in as a browser's navigation sends it: the provider answers a 302 instead.
    const four = pkce();
    const again = (await acme.handle(
      request(authorizePath(WEB, four.challenge, MCP, { redirect_uri: WEB_REDIRECT })),
    ))!;
    const { search } = new URL(again.headers.get("location")!, ORIGIN);
    await acme.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", { body: { email: DECLARED, type: "sign-in" } }),
    );
    const navigating = request("/auth/better-auth/sign-in/email-otp", {
      body: { email: DECLARED, otp: codes.get(DECLARED)!, oauth_query: search.slice(1) },
    });
    for (const [name, value] of Object.entries({
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      accept: "text/html",
    }))
      navigating.headers.set(name, value);
    const navigated = (await acme.handle(navigating))!;
    expect(navigated.status).toBe(302);
    // The session's cookie comes through the rewritten answer.
    expect(navigated.headers.getSetCookie().some((c) => c.includes("session_token="))).toBe(true);
    const to = new URL(navigated.headers.get("location")!);
    expect(to.searchParams.get("code")).toMatch(/^acme\./);
    expect((await exchange(acme, to.searchParams.get("code")!, four.verifier, WEB, WEB_REDIRECT)).status).toBe(200);
  });

  it("leaves a refusal at the client's redirect as it is: no code, so no tag", async () => {
    const issued = await connect(acme);
    const asked = (await acme.handle(
      request(authorizePath(CLAUDE_CODE, pkce().challenge, MCP), { cookie: issued.cookie }),
    ))!;
    const { search } = new URL(asked.headers.get("location")!, ORIGIN);
    const denied = (await acme.handle(
      request("/auth/better-auth/oauth2/consent", {
        body: { accept: false, oauth_query: search.slice(1) },
        cookie: issued.cookie,
      }),
    ))!;
    const { url } = (await denied.json()) as { url: string };
    expect(new URL(url).searchParams.get("error")).toBe("access_denied");
    expect(new URL(url).searchParams.get("iss")).toBe(ROUTER);
    expect(new URL(url).searchParams.has("code")).toBe(false);
  });

  it("refuses at /mcp a token of another company's, though the same keys signed it for the same router", async () => {
    // Another company's login on the same tables and keys: the tag is all that tells them apart.
    const globex = loginAt(routed("globex"));
    const ours = (await connect(acme)).body.access_token!;
    const theirs = (await connect(globex)).body.access_token!;
    expect(claimsOf(theirs)).toMatchObject({ iss: ROUTER, aud: MCP, sanoma_company: "globex" });
    expect(await bearerOf(globex, theirs)).toMatchObject({ client: CLAUDE_CODE });
    expect(await bearerOf(acme, theirs)).toBeNull();
    expect(await bearerOf(globex, ours)).toBeNull();
    // Nor does either take the other's code or refresh token.
    const { code, verifier } = await codeFor(acme);
    expect((await exchange(globex, code, verifier)).status).toBe(400);
    expect((await exchange(acme, code, verifier)).status).toBe(200);
  });

  it("refuses a token the instance's own address would have named: only the router's issuer and audience are good", async () => {
    const own = loginAt({ issuer: `${ORIGIN}/auth/better-auth`, resource: `${ORIGIN}/mcp` });
    const issued = await connectAt(flow, own, { client: CLAUDE_CODE, resource: `${ORIGIN}/mcp` });
    expect(issued.status).toBe(200);
    // An address of the app's own tags nothing.
    expect(issued.back.searchParams.get("code")).not.toContain(".");
    expect(claimsOf(issued.body.access_token!)).not.toHaveProperty("sanoma_company");
    expect(await bearerOf(acme, issued.body.access_token!)).toBeNull();
    expect(await bearerOf(own, (await connect(acme)).body.access_token!)).toBeNull();
  });
});

/** Twenty-five token requests from the router's one socket, each naming a caller. */
const statuses = async (socket: string, caller: (i: number) => string, secret?: string) => {
  const answered: number[] = [];
  for (let i = 0; i < 25; i++) {
    const asking = request("/auth/better-auth/oauth2/token", {
      form: { grant_type: "refresh_token", refresh_token: "acme.nothing", client_id: CLAUDE_CODE, resource: MCP },
      origin: null,
    });
    asking.headers.set(CLIENT_IP_HEADER, socket);
    asking.headers.set(ROUTER_CLIENT_IP_HEADER, caller(i));
    if (secret !== undefined) asking.headers.set(ROUTER_SECRET_HEADER, secret);
    answered.push((await acme.handle(asking))!.status);
  }
  return answered;
};

describe("the caller's address a router names", () => {
  const SOCKET = "203.0.113.50";
  /** A request as the app's host hands it over: its socket's address, and what the router said. */
  const forwarded = (headers: Record<string, string>) =>
    new Request(`http://${HOST}/auth/better-auth/oauth2/token`, {
      method: "POST",
      headers: { [CLIENT_IP_HEADER]: SOCKET, ...headers },
    });

  it("is taken for the caller's only with the router's secret, and neither header goes further", async () => {
    const named = { [ROUTER_CLIENT_IP_HEADER]: "198.51.100.7" };
    const believed = withRoutedCaller(forwarded({ ...named, [ROUTER_SECRET_HEADER]: SECRET }), ACME);
    expect(believed.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
    for (const headers of [
      named,
      { ...named, [ROUTER_SECRET_HEADER]: "" },
      { ...named, [ROUTER_SECRET_HEADER]: `${SECRET}x` },
      { ...named, [ROUTER_SECRET_HEADER]: SECRET.slice(1) },
      { ...named, [ROUTER_SECRET_HEADER]: SECRET.toUpperCase() },
    ]) {
      const ignored = withRoutedCaller(forwarded(headers), ACME);
      expect(ignored.headers.get(CLIENT_IP_HEADER), JSON.stringify(headers)).toBe(SOCKET);
    }
    // The request goes on whole: its method and its body.
    const posted = new Request(`http://${HOST}/auth/better-auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...named, [ROUTER_SECRET_HEADER]: SECRET },
      body: "grant_type=refresh_token",
    });
    const sent = withRoutedCaller(posted, ACME);
    expect([sent.method, sent.url, sent.headers.get("content-type")]).toEqual([
      "POST",
      posted.url,
      "application/x-www-form-urlencoded",
    ]);
    expect(await sent.text()).toBe("grant_type=refresh_token");
    // The secret alone, naming no address, changes nothing.
    expect(withRoutedCaller(forwarded({ [ROUTER_SECRET_HEADER]: SECRET }), ACME).headers.get(CLIENT_IP_HEADER)).toBe(
      SOCKET,
    );
    // An address of the app's own believes no router, whatever is sent.
    const own = { issuer: `${ORIGIN}/auth/better-auth`, resource: `${ORIGIN}/mcp` };
    const unrouted = withRoutedCaller(forwarded({ ...named, [ROUTER_SECRET_HEADER]: SECRET }), own);
    expect(unrouted.headers.get(CLIENT_IP_HEADER)).toBe(SOCKET);
    for (const answered of [believed, unrouted]) {
      expect(answered.headers.has(ROUTER_SECRET_HEADER)).toBe(false);
      expect(answered.headers.has(ROUTER_CLIENT_IP_HEADER)).toBe(false);
    }
  });

  it("is what the token endpoint's rate limit counts by, with the secret; without it, the socket's", async () => {
    // With the secret, each caller is counted alone: none is held, though all came from one socket.
    expect(await statuses("203.0.113.61", (i) => `198.51.100.${i + 1}`, SECRET)).not.toContain(429);
    // And one caller is held, whatever the socket: the twenty-first is refused.
    expect((await statuses("203.0.113.62", () => "198.51.100.200", SECRET)).indexOf(429)).toBe(20);
    // Without the secret, or with a wrong one, what a request names is not read: the socket is counted.
    expect((await statuses("203.0.113.63", (i) => `198.51.100.${i + 1}`)).indexOf(429)).toBe(20);
    expect((await statuses("203.0.113.64", (i) => `198.51.100.${i + 1}`, "wrong")).indexOf(429)).toBe(20);
  });
});
