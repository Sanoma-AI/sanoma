import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuthStaffLogin, declaredMetadataFetch, prepareBetterAuthStaff } from "sanoma/better-auth";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { defineWorkflow, type SanomaConfig } from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTOR_HEADER, AGENT_HEADER } from "../src/api.ts";
import { type App, startApp, staffLogin } from "../src/index.ts";
import { CLAUDE_CODE, CLAUDE_CODE_DOCUMENT, cookieOf, resetStaffSchema } from "./staff-oauth-helpers.ts";

// Needs Postgres (`pnpm db:up`) and the app built (`pnpm --filter sanoma build`). `/mcp` on a
// hosted instance, through the app on Node with the staff login (Better Auth's): a client of its
// own (Claude Code's, by its published client id) finds the resource's and the authorization
// server's metadata from the 401, signs a declared person in by email code, is asked their
// consent, gets a JWT for the instance's configured `/mcp` from a form POST with no Origin, and
// calls the tools as the declared agent on that person's behalf. The agent address is configured,
// as `SANOMA_HOSTNAME` configures one: here the address the test's app listens on. Claude Code's metadata document is served
// by a stand-in for claude.ai: nothing here leaves the machine.

const UNDECLARED = "https://elsewhere.example/oauth/client.json";
const REDIRECT = "http://127.0.0.1:53682/callback";
const ADA = "ada@acme.test";

const root = mkdtempSync(join(tmpdir(), "sanoma-hosted-mcp-"));
mkdirSync(join(root, "resources"));
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "${ADA}" });
export const claudeCode = sanoma.agent({ id: "claude-code", client: "${CLAUDE_CODE}" });
`;
writeFileSync(join(root, "resources/people.ts"), PEOPLE);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs `run` while `resources/people.ts` says `people`, then puts the file back as it was. */
async function withPeople<T>(people: string, run: () => Promise<T>): Promise<T> {
  writeFileSync(join(root, "resources/people.ts"), people);
  try {
    return await run();
  } finally {
    writeFileSync(join(root, "resources/people.ts"), PEOPLE);
  }
}
/** The people with no agent for Claude Code. */
const UNDECLARED_CLIENT = PEOPLE.replace(/^export const claudeCode.*$/m, "");

const hello = defineWorkflow({
  name: "say-hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ to: z.string() }),
  uses: [],
  run: async (_ctx, { to }) => `Hello, ${to}`,
});

const databaseUrl = testDatabaseUrl("hosted_mcp");
const config: SanomaConfig = { workflows: [hello], connectors: [], root };
const testApp = useTestApp(config, { databaseUrl });

/** The codes the login mailed, by email: the sender, as the app's would run `login-code`. */
const codes = new Map<string, string>();
/** Each client metadata document fetched: a stand-in for claude.ai. */
const fetched: string[] = [];
const claudeAi = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  return url === CLAUDE_CODE ? Response.json(CLAUDE_CODE_DOCUMENT) : new Response("Not found", { status: 404 });
};

/** A port nothing listens on now: the address is configured before the app listens. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** The staff login as `sanoma serve` composes it, its codes kept here and claude.ai a stand-in; `origin` is its agent address's, none without. */
const loginAt = (origin?: string) =>
  staffLogin(
    (context) =>
      betterAuthStaffLogin(
        { ...context, sendCode: async (email, code) => void codes.set(email, code) },
        { fetchClientMetadata: declaredMetadataFetch(claudeAi) },
      ),
    {},
    origin === undefined ? undefined : { issuer: `${origin}/auth/better-auth`, resource: `${origin}/mcp` },
  );

let app: App;
beforeAll(async () => {
  await resetStaffSchema(databaseUrl);
  await prepareBetterAuthStaff(databaseUrl);
  const port = await freePort();
  app = await startApp(testApp.config, { port, login: loginAt(`http://127.0.0.1:${port}`) });
  if (app.url !== `http://127.0.0.1:${port}`) throw new Error(`the app listens at ${app.url}, not at its address`);
}, 60_000);
afterAll(async () => {
  await app?.close();
});

const at = (path: string) => new URL(path, app.url).href;
/** A page's change, from the app's own origin, as the sign-in and consent pages post. */
const fromPage = (path: string, body: unknown, cookie?: string) =>
  fetch(at(path), {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.url, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
  });

/** A bearer, as a client sends its access token. */
const bearerOf = (token: string) => ({ authorization: `Bearer ${token}` });

/** A JSON-RPC request to `/mcp` (or to `url`, another address of it), as an MCP client sends it: no Origin. */
async function mcp(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  url = at("/mcp"),
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .at(-1)
        ?.slice("data:".length)
    : text;
  return { status: res.status, headers: res.headers, body: data ? JSON.parse(data) : undefined };
}

/**
 * The browser the client opens on `url`: a navigation, answered with a redirect, never followed
 * here. Node's `fetch` says `Sec-Fetch-Mode: cors` whatever it is given, which a provider answers
 * with JSON instead: `node:http` says what a browser's navigation says.
 */
function navigate(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } }, (res) => {
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

/** What a client does from the 401 to a token: discovery, authorize, the person's sign-in and consent, the code for tokens. */
async function signIn(client = CLAUDE_CODE) {
  const challenged = await mcp("tools/list", {});
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenged.headers.get("www-authenticate") ?? "")?.[1];
  const resource = (await (await fetch(metadataUrl!)).json()) as { resource: string; authorization_servers: string[] };
  const issuer = new URL(resource.authorization_servers[0]!);
  const server = (await (
    await fetch(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer))
  ).json()) as { authorization_endpoint: string; token_endpoint: string };
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s1",
    resource: resource.resource,
  });
  const authorized = await navigate(`${server.authorization_endpoint}?${query}`);
  return { authorized, verifier, server, resource: resource.resource };
}

/** The token endpoint's exchange, as Claude Code sends it: a form, no Origin, no cookie; its code and PKCE verifier for tokens. */
const exchange = (server: { token_endpoint: string }, code: string, verifier: string, resource: string) =>
  fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLAUDE_CODE,
      code_verifier: verifier,
      resource,
    }),
  });

/**
 * The whole sign-in for Claude Code, Ada's: from the 401 to its tokens, consenting when asked.
 * Every request is the client's or the login's own: none of them is a page of the app.
 */
async function connect() {
  const { authorized, verifier, server, resource } = await signIn();
  expect(authorized.status).toBe(302);
  const login = new URL(authorized.headers.get("location")!, app.url);
  await fromPage("/auth/better-auth/email-otp/send-verification-otp", { email: ADA, type: "sign-in" });
  const signed = await fromPage("/auth/better-auth/sign-in/email-otp", {
    email: ADA,
    otp: codes.get(ADA),
    oauth_query: login.search.slice(1),
  });
  const cookie = cookieOf(signed);
  let next = new URL(((await signed.json()) as { url: string }).url, app.url);
  if (next.pathname === "/auth/consent") {
    const allowed = await fromPage(
      "/auth/better-auth/oauth2/consent",
      { accept: true, oauth_query: next.search.slice(1) },
      cookie,
    );
    next = new URL(((await allowed.json()) as { url: string }).url);
  }
  const exchanged = await exchange(server, next.searchParams.get("code")!, verifier, resource);
  expect(exchanged.status).toBe(200);
  const issued = (await exchanged.json()) as { access_token: string; refresh_token: string };
  return { ...issued, server, resource, cookie };
}

/**
 * Claude Code's tokens for Ada, from one sign-in for the tests that need them: a sign-in by code
 * is rate limited per address (three in ten seconds), and every request here is from this one.
 */
let connected: ReturnType<typeof connect> | undefined;
const tokens = () => (connected ??= connect());

/** The token endpoint's refresh, as the client sends it. */
const refresh = (issued: { refresh_token: string; resource: string; server: { token_endpoint: string } }) =>
  fetch(issued.server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: CLAUDE_CODE,
      resource: issued.resource,
    }),
  });

describe("the agent surface on a host", () => {
  it("answers /mcp without a token 401, pointing at its metadata: CIMD, public clients and S256", async () => {
    const { status, headers } = await mcp("tools/list", {});
    expect(status).toBe(401);
    const metadataUrl = `${app.url}/.well-known/oauth-protected-resource/mcp`;
    expect(headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${metadataUrl}"`);
    expect(await (await fetch(metadataUrl)).json()).toMatchObject({
      resource: `${app.url}/mcp`,
      authorization_servers: [`${app.url}/auth/better-auth`],
    });
    const server = (await (
      await fetch(at("/.well-known/oauth-authorization-server/auth/better-auth"))
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: `${app.url}/auth/better-auth`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
    expect(server.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("signs a declared person in for Claude Code by email code, and its token reaches /mcp as the agent for them", async () => {
    const { authorized, verifier, server, resource } = await signIn();
    expect(authorized.status).toBe(302);
    const login = new URL(authorized.headers.get("location")!, app.url);
    expect(login.pathname).toBe("/auth/login");
    // The sign-in page carries the signed request on; a code to the declared email, then the code.
    const signInPage = await fetch(login);
    // No other site may frame a page that asks for a code or an answer.
    expect(signInPage.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(signInPage.headers.get("x-frame-options")).toBe("DENY");
    const page = await signInPage.text();
    expect(page).toContain("oauth_query");
    expect(
      (await fromPage("/auth/better-auth/email-otp/send-verification-otp", { email: ADA, type: "sign-in" })).status,
    ).toBe(200);
    const signed = await fromPage("/auth/better-auth/sign-in/email-otp", {
      email: ADA,
      otp: codes.get(ADA),
      oauth_query: login.search.slice(1),
    });
    expect(signed.status).toBe(200);
    const cookie = cookieOf(signed);
    const consentAt = new URL(((await signed.json()) as { url: string }).url, app.url);
    expect(consentAt.pathname).toBe("/auth/consent");
    const consentAnswer = await fetch(consentAt, { headers: { cookie } });
    expect(consentAnswer.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(consentAnswer.headers.get("x-frame-options")).toBe("DENY");
    const consentPage = await consentAnswer.text();
    expect(consentPage).toContain("Let claude-code act for you?");
    const allowed = await fromPage(
      "/auth/better-auth/oauth2/consent",
      { accept: true, oauth_query: consentAt.search.slice(1) },
      cookie,
    );
    const back = new URL(((await allowed.json()) as { url: string }).url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    // The token endpoint: a form, no Origin, no cookie.
    const exchanged = await exchange(server, back.searchParams.get("code")!, verifier, resource);
    expect(exchanged.status).toBe(200);
    const { access_token } = (await exchanged.json()) as { access_token: string };
    const claims = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ aud: `${app.url}/mcp`, iss: `${app.url}/auth/better-auth`, azp: CLAUDE_CODE });
    expect(fetched).toEqual([CLAUDE_CODE]);

    const bearer = bearerOf(access_token);
    const listed = await mcp("tools/list", {}, bearer);
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain("start_run");
    const started = await mcp(
      "tools/call",
      { name: "start_run", arguments: { workflow: "say-hello", input: { to: "Bo" } } },
      bearer,
    );
    expect(started.body.result.isError, JSON.stringify(started.body)).toBeFalsy();
    const { runId } = started.body.result.structuredContent as { runId: string };
    const run = await testApp.client.run(runId);
    expect(run?.startedBy).toEqual({ id: "claude-code", groups: ["agents"], onBehalfOf: "ada" });

    // The token is for the configured address's /mcp, whatever name the app is reached by: on
    // another Host it is good too, and a client with none is sent to the configured address.
    const elsewhere = at("/mcp").replace("127.0.0.1", "localhost");
    expect((await mcp("tools/list", {}, bearer, elsewhere)).status).toBe(200);
    const unsigned = await mcp("tools/list", {}, {}, elsewhere);
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${app.url}/.well-known/oauth-protected-resource/mcp"`,
    );
    const forged = await mcp("tools/list", {}, bearerOf(`${access_token.slice(0, -2)}AA`), elsewhere);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    // Nor is there a document for that Host: the one it serves there is the configured address's.
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/auth/better-auth",
    ]) {
      const document = await fetch(at(path).replace("127.0.0.1", "localhost"));
      expect(document.headers.has("vary"), path).toBe(false);
      const text = await document.text();
      expect(text, path).not.toContain("localhost");
      expect(text, path).toContain(`${app.url}/auth/better-auth`);
    }
    // A loopback header is no sign-in on a host, beside a token or not.
    expect((await mcp("tools/list", {}, { ...bearer, [AGENT_HEADER]: "claude-code" })).status).toBe(400);
    expect((await mcp("tools/list", {}, { [ACTOR_HEADER]: "ada" })).status).toBe(401);

    // Once no agent declares the client, its token is refused, however recent.
    await withPeople(UNDECLARED_CLIENT, async () => {
      const refused = await mcp("tools/list", {}, bearer);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "not_admitted", error: expect.stringContaining(CLAUDE_CODE) });
    });
  });

  it("reads the people as the files say now at the login's own routes, with no page asked in between", async () => {
    const signedIn = await tokens();
    // Undeclared: the token endpoint and authorize are all that is asked, and both refuse.
    writeFileSync(join(root, "resources/people.ts"), PEOPLE.replace(/^export const claudeCode.*$/m, ""));
    try {
      const refreshed = await refresh(signedIn);
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: "invalid_client" });
      expect((await signIn()).authorized.status).toBe(403);
    } finally {
      writeFileSync(join(root, "resources/people.ts"), PEOPLE);
    }
    // Declared again: authorize goes on to the sign-in, again with nothing else asked.
    const { authorized } = await signIn();
    expect(authorized.status).toBe(302);
    expect(new URL(authorized.headers.get("location")!, app.url).pathname).toBe("/auth/login");
  });

  it("takes a bearer at /mcp alone, by its scheme in any case, and challenges anything else there", async () => {
    const { access_token } = await tokens();
    const challenge = `Bearer resource_metadata="${app.url}/.well-known/oauth-protected-resource/mcp"`;
    // The scheme is case-insensitive (RFC 9110 §11.1).
    expect((await mcp("tools/list", {}, { authorization: `bearer ${access_token}` })).status).toBe(200);
    // `/mcp/` is `/mcp`: the same token, the same challenges.
    const slash = (headers: Record<string, string>) => mcp("tools/list", {}, headers, at("/mcp/"));
    const none = await slash({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(challenge);
    const bad = await slash({ authorization: "Bearer a.b.c" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    expect((await slash(bearerOf(access_token))).status).not.toBe(401);
    // A DPoP token, or any other scheme, is not a bearer: the challenge names the one taken here.
    const dpop = await mcp("tools/list", {}, { authorization: `DPoP ${access_token}` });
    expect(dpop.status).toBe(401);
    expect(dpop.headers.get("www-authenticate")).toBe(challenge);
    // Anywhere but /mcp a bearer is nobody: a page and a server function are the sign-in's.
    const page = await fetch(at("/"), { headers: bearerOf(access_token) });
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    const call = await fetch(at("/auth/invite"), {
      method: "POST",
      headers: { ...bearerOf(access_token), "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ email: ADA }),
    });
    expect(call.status).toBe(401);
  });

  it("refuses a bearer once the person it was issued for is no longer declared", async () => {
    const { access_token } = await tokens();
    const withoutAda = PEOPLE.replace(
      /^export const ada.*$/m,
      'export const bo = sanoma.person({ id: "bo", email: "bo@acme.test" });',
    );
    await withPeople(withoutAda, async () => {
      const refused = await mcp("tools/list", {}, bearerOf(access_token));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "not_admitted" });
    });
  });

  it("refuses a client's tokens once the files move it to another agent than its person consented to", async () => {
    const signedIn = await tokens();
    const moved = PEOPLE.replace('id: "claude-code"', 'id: "other-bot"');
    await withPeople(moved, async () => {
      // Its access token: the 401 that sends the client to sign in again, where the person is asked about the new agent.
      const refused = await mcp("tools/list", {}, bearerOf(signedIn.access_token));
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
      // Its refresh token gets no token for the new agent either.
      const refreshed = await refresh(signedIn);
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    });
    // Moved back, both are the consented agent's again.
    expect((await mcp("tools/list", {}, bearerOf(signedIn.access_token))).status).toBe(200);
    expect((await refresh(signedIn)).status).toBe(200);
  });

  it("refuses an undeclared client at authorize, saying where one is declared, and fetches nothing of it", async () => {
    fetched.length = 0;
    const { authorized } = await signIn(UNDECLARED);
    expect(authorized.status).toBe(403);
    expect(authorized.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const page = await authorized.text();
    expect(page).toContain("resources/people.ts");
    expect(page).toContain(UNDECLARED);
    // No declaration ready to paste: the client's id is whatever the link that sent here said.
    expect(page).not.toContain("sanoma.agent(");
    expect(fetched).toEqual([]);
  });

  it("answers a well-known path it does not serve 404, signed in or not: never the sign-in page", async () => {
    const { cookie } = await tokens();
    for (const path of [
      "/.well-known/x",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      for (const headers of [{}, { cookie }]) {
        const lost = await fetch(at(path), { headers: { accept: "text/html", ...headers } });
        expect([lost.status, lost.headers.get("content-type")], path).toEqual([404, "text/plain;charset=UTF-8"]);
      }
    }
  });
});

describe("a host with no agent address", () => {
  let plain: App;
  beforeAll(async () => {
    plain = await startApp(testApp.config, { port: 0, login: loginAt() });
  }, 60_000);
  afterAll(async () => {
    await plain?.close();
  });
  const on = (path: string) => new URL(path, plain.url).href;

  it("serves no OAuth for /mcp: its 401 names no scheme and says what to set, and nothing is discovered", async () => {
    for (const headers of [{}, bearerOf("a.b.c")]) {
      const refused = await mcp("tools/list", {}, headers, on("/mcp"));
      expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([401, null]);
      expect(refused.body.error).toContain("Set SANOMA_HOSTNAME");
    }
    // A token the addressed app on the same database issued is nobody here.
    const { access_token } = await tokens();
    expect((await mcp("tools/list", {}, bearerOf(access_token), on("/mcp"))).status).toBe(401);
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server/auth/better-auth",
      "/auth/better-auth/oauth2/authorize?client_id=x",
      "/auth/better-auth/jwks",
    ]) {
      expect((await fetch(on(path), { headers: { accept: "text/html" } })).status, path).toBe(404);
    }
    const token = await fetch(on("/auth/better-auth/oauth2/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "nothing", client_id: CLAUDE_CODE }),
    });
    expect(token.status).toBe(404);
  });

  it("still signs a person in, who reaches /mcp as themselves", async () => {
    const post = (path: string, body: unknown) =>
      fetch(on(path), {
        method: "POST",
        headers: { "content-type": "application/json", origin: plain.url },
        body: JSON.stringify(body),
      });
    await post("/auth/better-auth/email-otp/send-verification-otp", { email: ADA, type: "sign-in" });
    const signed = await post("/auth/better-auth/sign-in/email-otp", { email: ADA, otp: codes.get(ADA) });
    expect(signed.status).toBe(200);
    const listed = await mcp("tools/list", {}, { cookie: cookieOf(signed) }, on("/mcp"));
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain("start_run");
  });
});
