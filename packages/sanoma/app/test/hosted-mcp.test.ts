import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuthStaffLogin, declaredMetadataFetch, prepareBetterAuthStaff } from "sanoma/better-auth";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { defineWorkflow, type SanomaConfig } from "sanoma/workflows";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTOR_HEADER, AGENT_HEADER } from "../src/api.ts";
import { type App, startApp, staffLogin } from "../src/index.ts";

// Needs Postgres (`pnpm db:up`) and the app built (`pnpm --filter sanoma build`). `/mcp` on a
// hosted instance, through the app on Node with the staff login (Better Auth's): a client of its
// own (Claude Code's, by its published client id) finds the resource's and the authorization
// server's metadata from the 401, signs a declared person in by email code, is asked their
// consent, gets a JWT for the instance's own `/mcp` from a form POST with no Origin, and calls the
// tools as the declared agent on that person's behalf. Claude Code's metadata document is served
// by a stand-in for claude.ai: nothing here leaves the machine.

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
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
  if (url !== CLAUDE_CODE) return new Response("Not found", { status: 404 });
  return Response.json({
    client_id: CLAUDE_CODE,
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
};

let app: App;
beforeAll(async () => {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await db.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth_staff");
  await db.end();
  await prepareBetterAuthStaff(databaseUrl);
  app = await startApp(testApp.config, {
    port: 0,
    login: staffLogin((context) =>
      betterAuthStaffLogin(
        { ...context, sendCode: async (email, code) => void codes.set(email, code) },
        { fetchClientMetadata: declaredMetadataFetch(claudeAi) },
      ),
    ),
  });
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
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/** A JSON-RPC request to `/mcp`, as an MCP client sends it: no Origin. */
async function mcp(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(at("/mcp"), {
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
  const exchanged = await fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: next.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: CLAUDE_CODE,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  return { ...tokens, server, resource, cookie };
}

/** The token endpoint's refresh, as the client sends it. */
const refresh = (tokens: { refresh_token: string; resource: string; server: { token_endpoint: string } }) =>
  fetch(tokens.server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLAUDE_CODE,
      resource: tokens.resource,
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
    const page = await (await fetch(login)).text();
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
    const consentPage = await (await fetch(consentAt, { headers: { cookie } })).text();
    expect(consentPage).toContain("Let claude-code act for you?");
    const allowed = await fromPage(
      "/auth/better-auth/oauth2/consent",
      { accept: true, oauth_query: consentAt.search.slice(1) },
      cookie,
    );
    const back = new URL(((await allowed.json()) as { url: string }).url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    // The token endpoint: a form, no Origin, no cookie.
    const exchanged = await fetch(server.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: CLAUDE_CODE,
        code_verifier: verifier,
        resource,
      }),
    });
    expect(exchanged.status).toBe(200);
    const { access_token } = (await exchanged.json()) as { access_token: string };
    const claims = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ aud: `${app.url}/mcp`, iss: `${app.url}/auth/better-auth`, azp: CLAUDE_CODE });
    expect(fetched).toEqual([CLAUDE_CODE]);

    const bearer = { authorization: `Bearer ${access_token}` };
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

    // The token is for this host's /mcp alone: another host's /mcp refuses it, 401.
    const elsewhere = await fetch(at("/mcp").replace("127.0.0.1", "localhost"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bearer },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    // A loopback header is no sign-in on a host, beside a token or not.
    expect((await mcp("tools/list", {}, { ...bearer, [AGENT_HEADER]: "claude-code" })).status).toBe(400);
    expect((await mcp("tools/list", {}, { [ACTOR_HEADER]: "ada" })).status).toBe(401);

    // Once no agent declares the client, its token is refused, however recent.
    writeFileSync(join(root, "resources/people.ts"), PEOPLE.replace(/^export const claudeCode.*$/m, ""));
    try {
      const refused = await mcp("tools/list", {}, bearer);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "not_admitted", error: expect.stringContaining(CLAUDE_CODE) });
    } finally {
      writeFileSync(join(root, "resources/people.ts"), PEOPLE);
    }
  });

  it("reads the people as the files say now at the login's own routes, with no page asked in between", async () => {
    const tokens = await connect();
    // Undeclared: the token endpoint and authorize are all that is asked, and both refuse.
    writeFileSync(join(root, "resources/people.ts"), PEOPLE.replace(/^export const claudeCode.*$/m, ""));
    try {
      const refreshed = await refresh(tokens);
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

  it("refuses an undeclared client at authorize, naming what to declare, and fetches nothing of it", async () => {
    fetched.length = 0;
    const { authorized } = await signIn(UNDECLARED);
    expect(authorized.status).toBe(403);
    const page = await authorized.text();
    expect(page).toContain("resources/people.ts");
    expect(page).toContain(`client: &quot;${UNDECLARED}&quot;`);
    expect(fetched).toEqual([]);
  });
});
