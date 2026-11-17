import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuthStaffLogin, declaredMetadataFetch, prepareBetterAuthStaff } from "sanoma/better-auth";
import { collection } from "sanoma/data";
import { testDatabaseUrl } from "sanoma/testing";
import {
  CLIENT_IP_HEADER,
  defineWorkflow,
  type ResolvedRouter,
  routedAgentAddress,
  ROUTER_CLIENT_IP_HEADER,
  ROUTER_SECRET_HEADER,
  routerSecretFor,
  SanomaClient,
  type SanomaConfig,
} from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type App, startApp, staffLogin } from "../src/index.ts";
import { agentRouter, companyBase, companyOfToken } from "../src/agent-router.ts";
import { freePort } from "../src/steps/agent/local-box.ts";
import { prepareDatabase } from "../../workflows/src/db.ts";
import {
  allowAt,
  authorizeQuery,
  CLAUDE_CODE,
  CLAUDE_CODE_DOCUMENT,
  codeForm,
  navigate,
  REDIRECT,
  refreshForm,
  resetStaffSchema,
  rpc,
  rpcAnswer,
  signInByCode,
} from "./staff-oauth-helpers.ts";

// Needs Postgres (`pnpm db:up`) and the app built (`pnpm --filter sanoma build`). The agents'
// router (`config.router`, sanoma#777), in one process: a router app and two companies' apps,
// `acme` and `globex`, each on a database of its own with its own people and signing keys, each
// with the router's `/mcp` as its agent address. A client finds everything from the router: its
// metadata, the page that asks which company, then that company's own sign-in and consent on
// the company's host, and after that the token endpoint, `/mcp`, a refresh and a revocation
// through the router alone, which reads the company off each code and token and checks nothing.
// The router forwards with a `fetch` that notes every address it contacts. First, the router
// alone over stand-ins: what it forwards, and what it never does.

const ROUTER_HOST = "mcp.router.test";
const ROUTER = `https://${ROUTER_HOST}`;
/** The router's master secret: what it is configured with, and sends to no one. */
const MASTER = "the-router's-master-secret-0123456789";

/** A JWT with this payload, signed by nobody: all a router reads of one. */
const unsigned = (payload: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
/** A token with its payload's company claim changed, its signature as it was: a forged tag. */
function retagged(token: string, tag: string): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  const forged = Buffer.from(JSON.stringify({ ...claims, sanoma_company: tag })).toString("base64url");
  return `${header}.${forged}.${signature}`;
}

/** What a company's stand-in answers unless a test says otherwise. */
const fine = () => Response.json({ ok: true });

describe("the router, over stand-ins", () => {
  const routing: ResolvedRouter = {
    hostname: ROUTER_HOST,
    companies: { collection: "companies", url: "url", live: { field: "status", is: ["live"] } },
  };
  const LIST: Record<string, Record<string, unknown>> = {
    acme: { slug: "acme", url: "https://acme.example", status: "live" },
    local: { slug: "local", url: "http://127.0.0.1:8787", status: "live" },
    paused: { slug: "paused", url: "https://paused.example", status: "stopped" },
    pathed: { slug: "pathed", url: "https://pathed.example/app", status: "live" },
    plain: { slug: "plain", url: "http://plain.example", status: "live" },
    usered: { slug: "usered", url: "https://user:pass@usered.example", status: "live" },
    queried: { slug: "queried", url: "https://queried.example?to=x", status: "live" },
    unwritten: { slug: "unwritten", status: "live" },
    "bad.id": { slug: "bad.id", url: "https://bad.example", status: "live" },
  };
  /** The keys the router asked the list for, and each request it forwarded. */
  const asked: string[] = [];
  const sent: Request[] = [];
  let answer: (request: Request) => Response | Promise<Response> = fine;
  /** What each forward was asked to send with, as `fetch` was given it. */
  const inits: RequestInit[] = [];
  const made = (secret: string | null = MASTER) =>
    agentRouter({
      router: routing,
      ...(secret && { secret }),
      // As `SanomaClient.routedCompany` answers: where the company is, and whether it is routed to.
      company: async (id) => {
        asked.push(`companies/${id}`);
        const record = Object.hasOwn(LIST, id) ? LIST[id]! : undefined;
        return record && { ...(typeof record.url === "string" && { url: record.url }), live: record.status === "live" };
      },
      fetch: async (input, init) => {
        inits.push(init!);
        const request = new Request(input as string, init);
        sent.push(request);
        return answer(request);
      },
    });
  /** The companies the list has and the router does not send to now: not live, or a URL it refuses. */
  const UNAVAILABLE = ["paused", "pathed", "plain", "usered", "queried", "unwritten"];
  const router = made();
  const at = (path: string, init: RequestInit = {}) =>
    router.handle(new Request(`https://${ROUTER_HOST}${path}`, init));
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    at(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  const fresh = () => {
    asked.length = 0;
    sent.length = 0;
    inits.length = 0;
    answer = fine;
  };

  it("reads the company off a token without checking it: an access token's claim, else a code's or a refresh token's tag", () => {
    expect(companyOfToken("acme.Zx81")).toBe("acme");
    expect(companyOfToken(unsigned({ sanoma_company: "globex" }))).toBe("globex");
    // A JWT with no claim names what is before its first dot, which is no company's id.
    expect(companyOfToken(unsigned({ sub: "x" }))).toBe(Buffer.from('{"alg":"none"}').toString("base64url"));
    for (const none of ["", "acme", ".acme", "acme."]) expect(companyOfToken(none), none).toBeUndefined();
  });

  it("serves its two metadata documents, naming itself and its own endpoints, with no keys", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const answered = await at(path);
      expect(answered.status, path).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("private, max-age=300");
      expect(await answered.json(), path).toEqual({
        resource: `${ROUTER}/mcp`,
        authorization_servers: [ROUTER],
        bearer_methods_supported: ["header"],
      });
    }
    expect(await (await at("/.well-known/oauth-authorization-server")).json()).toEqual({
      issuer: ROUTER,
      authorization_endpoint: `${ROUTER}/authorize`,
      token_endpoint: `${ROUTER}/token`,
      revocation_endpoint: `${ROUTER}/revoke`,
      scopes_supported: ["offline_access"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect((await at("/.well-known/oauth-authorization-server", { method: "HEAD" })).status).toBe(200);
    expect((await at("/.well-known/oauth-authorization-server", { method: "POST" })).status).toBe(405);
  });

  it("answers nothing but its own routes", async () => {
    for (const path of [
      "/",
      "/healthz",
      "/auth/login",
      "/auth/better-auth/oauth2/token",
      "/.well-known/oauth-authorization-server/auth/better-auth",
      "/.well-known/openid-configuration",
      "/jwks",
      "/mcp/",
      "/token/",
      "/api/token/redeem",
    ]) {
      expect((await at(path)).status, path).toBe(404);
    }
    expect((await at("/token")).status).toBe(405);
    expect((await at("/revoke")).status).toBe(405);
    expect((await at("/authorize", { method: "POST" })).status).toBe(405);
    expect((await at("/mcp", { method: "PUT" })).status).toBe(405);
  });

  it("asks which company on a page no site can frame, and writes the client's query only escaped", async () => {
    const hostile = `"><script>alert(1)</script>`;
    const page = await at(`/authorize?client_id=${encodeURIComponent(hostile)}&state=a%26b&company=`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Which company?");
    expect(html).toContain('name="company"');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('name="client_id" value="&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;"');
    expect(html).toContain('name="state" value="a&#38;b"');
  });

  it("sends the browser to the listed company's own authorize with the query as it came, and nowhere else", async () => {
    fresh();
    const query = "response_type=code&client_id=https%3A%2F%2Fclient.example%2Fc.json&state=a%20b+c&resource=x";
    const answered = await at(`/authorize?company=acme&${query}`);
    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")).toBe(`https://acme.example/auth/better-auth/oauth2/authorize?${query}`);
    // Wherever the form put `company`, it is the router's own and goes no further.
    const last = await at(`/authorize?${query}&company=%20acme%20`);
    expect(last.headers.get("location")).toBe(`https://acme.example/auth/better-auth/oauth2/authorize?${query}`);
    // An id not listed, no id at all, or a host: the page again, saying so, never a redirect.
    for (const id of ["initech", "bad.id", "acme.example", "https://evil.example", "ACME"]) {
      const refused = await at(`/authorize?company=${encodeURIComponent(id)}&${query}&redirect_uri=x`);
      expect(refused.status, id).toBe(404);
      expect(refused.headers.has("location"), id).toBe(false);
      const html = await refused.text();
      expect(html, id).toContain("No company with that id is connected here");
      expect(html, id).toContain('name="redirect_uri" value="x"');
    }
    // The list is asked by the exact id alone, and nothing was fetched.
    expect(asked).toEqual(["companies/acme", "companies/acme", "companies/initech", "companies/ACME"]);
    expect(sent).toEqual([]);
  });

  it("says a listed company it does not route to now is not available, on the page and to a client, never that it is unknown", async () => {
    fresh();
    for (const id of UNAVAILABLE) {
      // The page again, saying the company is there and not available: never a redirect.
      const page = await at(`/authorize?company=${id}&client_id=x`);
      expect(page.status, id).toBe(503);
      expect(page.headers.get("retry-after"), id).toBe("60");
      expect(page.headers.has("location"), id).toBe(false);
      const html = await page.text();
      expect(html, id).toContain("That company is not available right now");
      expect(html, id).not.toContain("No company with that id");
      // A client keeps its code, its refresh token and its access token: asked to come back, not told they are no good.
      for (const refused of [
        await form("/token", { grant_type: "authorization_code", code: `${id}.Zx81` }),
        await form("/token", { grant_type: "refresh_token", refresh_token: `${id}.Rt` }),
        await form("/revoke", { token: `${id}.Rt` }),
        await at("/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${unsigned({ sanoma_company: id })}` },
          body: "{}",
        }),
      ]) {
        expect(refused.status, id).toBe(503);
        expect(refused.headers.get("retry-after"), id).toBe("60");
        expect(refused.headers.get("cache-control"), id).toBe("no-store");
        expect(refused.headers.has("www-authenticate"), id).toBe(false);
        expect(await refused.json(), id).toEqual({
          error: "temporarily_unavailable",
          error_description: "The company is not available right now",
        });
      }
    }
    expect(sent).toEqual([]);
  });

  it("sends only to an https origin with no path, user or query, and to plain http on this machine alone", async () => {
    for (const url of [
      "https://acme.example",
      "https://acme.example/",
      "HTTPS://Acme.Example:443",
      "https://a.example:8443",
    ]) {
      expect(companyBase(url), url).toBe(new URL(url).origin);
    }
    for (const local of ["http://127.0.0.1:8787", "http://localhost:3000", "http://[::1]:3000"]) {
      expect(companyBase(local), local).toBe(local);
    }
    for (const refused of [
      "http://acme.example",
      "http://10.0.0.7:3000",
      "http://169.254.169.254",
      "https://acme.example/app",
      "https://user@acme.example",
      "https://user:pass@acme.example",
      "https://acme.example?x=1",
      "https://acme.example#x",
      "ftp://acme.example",
      "acme.example",
      "",
      undefined,
      7,
    ]) {
      expect(companyBase(refused), String(refused)).toBeUndefined();
    }
    // A listed company on this machine over plain http is routed to: what the tests' instances are.
    fresh();
    const local = await at("/authorize?company=local&client_id=x");
    expect(local.headers.get("location")).toBe("http://127.0.0.1:8787/auth/better-auth/oauth2/authorize?client_id=x");
  });

  it("forwards a token request's form unchanged to the company its code names, with the caller's address and that company's own secret", async () => {
    fresh();
    answer = () =>
      Response.json(
        { access_token: "a", token_type: "Bearer" },
        { headers: { "cache-control": "no-store", pragma: "no-cache", "set-cookie": "sid=1", "x-other": "1" } },
      );
    const body = "grant_type=authorization_code&code=acme.Zx81&code_verifier=v%20v&client_id=c&x=%7E";
    const answered = await at("/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "sanoma.session_token=theirs",
        origin: "https://elsewhere.example",
        authorization: "Basic abc",
        [CLIENT_IP_HEADER]: "198.51.100.7",
        [ROUTER_CLIENT_IP_HEADER]: "10.0.0.1",
        [ROUTER_SECRET_HEADER]: "guess",
        "x-forwarded-for": "10.0.0.2",
      },
      body,
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ access_token: "a", token_type: "Bearer" });
    // The company's answer's own headers, never a cookie.
    expect(answered.headers.get("pragma")).toBe("no-cache");
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(answered.headers.has("set-cookie")).toBe(false);
    expect(answered.headers.has("x-other")).toBe(false);
    expect(sent).toHaveLength(1);
    const [forwarded] = sent;
    expect(forwarded!.url).toBe("https://acme.example/auth/better-auth/oauth2/token");
    expect(forwarded!.method).toBe("POST");
    expect(await forwarded!.text()).toBe(body);
    expect(Object.fromEntries(forwarded!.headers)).toEqual({
      "content-type": "application/x-www-form-urlencoded",
      [ROUTER_CLIENT_IP_HEADER]: "198.51.100.7",
      // The company's own, derived from the master, which is never sent.
      [ROUTER_SECRET_HEADER]: await routerSecretFor(MASTER, "acme"),
    });
    expect(forwarded!.headers.get(ROUTER_SECRET_HEADER)).not.toBe(MASTER);
    // A refresh is routed by the refresh token, a revocation by its token (an access token's claim too).
    await form("/token", { grant_type: "refresh_token", refresh_token: "acme.Rt", code: "globex.no" });
    expect(sent[1]!.url).toBe("https://acme.example/auth/better-auth/oauth2/token");
    await form("/revoke", { token: "acme.Rt", client_id: "c" });
    await form("/revoke", { token: unsigned({ sanoma_company: "acme" }), client_id: "c" });
    expect(sent.slice(2).map((r) => r.url)).toEqual(
      Array(2).fill("https://acme.example/auth/better-auth/oauth2/revoke"),
    );
    // Each of them with that company's secret; another company gets another, whoever asks.
    expect(new Set(sent.map((r) => r.headers.get(ROUTER_SECRET_HEADER)))).toEqual(
      new Set([await routerSecretFor(MASTER, "acme")]),
    );
    await form("/token", { grant_type: "authorization_code", code: "local.Zx81" });
    expect(sent.at(-1)!.url).toBe("http://127.0.0.1:8787/auth/better-auth/oauth2/token");
    expect(sent.at(-1)!.headers.get(ROUTER_SECRET_HEADER)).toBe(await routerSecretFor(MASTER, "local"));
  });

  it("reads a form no further than its limit, and never holds one larger", async () => {
    fresh();
    // Five megabytes that never end, with no length said: answered once the limit is passed.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });
    const refused = await at("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    // Read to just past four megabytes, and no further.
    expect(pulled).toBeGreaterThan(64);
    expect(pulled).toBeLessThan(80);
    // One that says its length is refused unread.
    const said = await at("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(5 * 1024 * 1024) },
      body: "token=acme.Rt",
    });
    expect(said.status).toBe(413);
    expect(sent).toEqual([]);
  });

  it("answers a code or token that names no listed company itself, in OAuth's words, and sends nothing", async () => {
    fresh();
    for (const code of ["Zx81", "initech.Zx81", "bad.id.Zx81", ".Zx81"]) {
      const refused = await form("/token", { grant_type: "authorization_code", code });
      expect(refused.status, code).toBe(400);
      expect(((await refused.json()) as { error: string }).error, code).toBe("invalid_grant");
      expect(refused.headers.has("location")).toBe(false);
    }
    const refresh = await form("/token", { grant_type: "refresh_token", refresh_token: "initech.Rt" });
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    // No code or token at all, or no form, is a request the router cannot read.
    for (const refused of [
      await form("/token", { grant_type: "authorization_code" }),
      await form("/token", { grant_type: "refresh_token", code: "acme.Zx81" }),
      await form("/revoke", { client_id: "c" }),
      await at("/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ]) {
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    }
    // RFC 7009: a token nobody here knows is revoked already.
    for (const token of ["Rt", "initech.Rt", unsigned({ sanoma_company: "initech" })]) {
      const revoked = await form("/revoke", { token });
      expect(revoked.status, token).toBe(200);
      expect(await revoked.text()).toBe("");
    }
    expect(sent).toEqual([]);
  });

  it("starts a client's sign-in at /mcp without a bearer, and refuses one that names no listed company", async () => {
    fresh();
    const metadata = `resource_metadata="${ROUTER}/.well-known/oauth-protected-resource/mcp"`;
    const posts: Record<string, string>[] = [{}, { authorization: "Basic abc" }, { cookie: "sanoma.session_token=x" }];
    for (const headers of posts) {
      const challenged = await at("/mcp", { method: "POST", headers, body: "{}" });
      expect(challenged.status).toBe(401);
      expect(challenged.headers.get("www-authenticate")).toBe(`Bearer ${metadata}`);
    }
    for (const bearer of [
      "not-a-jwt",
      "acme.Zx81",
      unsigned({ sub: "x" }),
      unsigned({ sanoma_company: "initech" }),
      unsigned({ sanoma_company: ["acme"] }),
      unsigned({ sanoma_company: "acme.example" }),
      `a.${Buffer.from("[]").toString("base64url")}.c`,
      "a.%%%.c",
    ]) {
      const refused = await at("/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: "{}" });
      expect(refused.status, bearer).toBe(401);
      expect(refused.headers.get("www-authenticate"), bearer).toBe(
        `Bearer error="invalid_token", error_description="The access token names no company connected here", ${metadata}`,
      );
      expect(await refused.json(), bearer).toEqual({ error: "Sign in first" });
    }
    expect(sent).toEqual([]);
  });

  it("forwards a /mcp call with its bearer and MCP's headers and nothing of the router's, and passes the answer on as it streams", async () => {
    fresh();
    const bearer = unsigned({ sanoma_company: "acme" });
    // An answer that never ends: its first event must come through before anything closes.
    let close!: () => void;
    answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
            close = () => controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1", "set-cookie": "sid=1" } },
      );
    const answered = await at("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "s0",
        cookie: "sanoma.session_token=theirs",
        [CLIENT_IP_HEADER]: "198.51.100.9",
        [ROUTER_CLIENT_IP_HEADER]: "10.0.0.1",
        [ROUTER_SECRET_HEADER]: "guess",
      },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe("text/event-stream");
    expect(answered.headers.get("mcp-session-id")).toBe("s1");
    expect(answered.headers.has("set-cookie")).toBe(false);
    const reader = answered.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: message\ndata: {}\n\n");
    close();
    expect((await reader.read()).done).toBe(true);
    const [forwarded] = sent;
    expect(forwarded!.url).toBe("https://acme.example/mcp");
    expect(await forwarded!.text()).toBe('{"jsonrpc":"2.0"}');
    // No secret and no caller's address: nothing at a company's /mcp reads either.
    expect(Object.fromEntries(forwarded!.headers)).toEqual({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "s0",
    });
    // A GET and a DELETE go on too, with no body.
    for (const method of ["GET", "DELETE"]) {
      answer = () => new Response(null, { status: 405 });
      const other = await at("/mcp", { method, headers: { authorization: `Bearer ${bearer}` } });
      expect(other.status).toBe(405);
      expect(sent.at(-1)!.method).toBe(method);
      expect(sent.at(-1)!.body).toBeNull();
    }
  });

  it("sends a /mcp body on as it comes, never read or held whole", async () => {
    fresh();
    const bearer = unsigned({ sanoma_company: "acme" });
    // A body whose first part is sent and whose end has not come: the company is asked all the same.
    let more!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        more = controller;
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":'));
      },
    });
    let read = "";
    answer = async (request) => {
      const reader = request.body!.getReader();
      read = new TextDecoder().decode((await reader.read()).value);
      // Its end is sent only once the company has read its start.
      more.enqueue(new TextEncoder().encode('"2.0"}'));
      more.close();
      for (let next = await reader.read(); !next.done; next = await reader.read())
        read += new TextDecoder().decode(next.value);
      return fine();
    };
    const answered = await at("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(answered.status).toBe(200);
    expect(read).toBe('{"jsonrpc":"2.0"}');
    expect(inits[0]!.body).toBeInstanceOf(ReadableStream);
    expect((inits[0] as { duplex?: string }).duplex).toBe("half");
    // Larger than any form it would read: sent on all the same, its size the company's to refuse.
    const large = "x".repeat(5 * 1024 * 1024);
    answer = async (request) => Response.json({ size: (await request.text()).length });
    const sized = await at("/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: large });
    expect(await sized.json()).toEqual({ size: large.length });
  });

  it("gives up on a company once its caller has gone, and waits for its first answer no longer than thirty seconds", async () => {
    fresh();
    const bearer = { authorization: `Bearer ${unsigned({ sanoma_company: "acme" })}` };
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A company that never answers: the request to it ends when the signal it was given does.
      const signals: AbortSignal[] = [];
      answer = (request) =>
        new Promise((_resolve, reject) => {
          signals.push(request.signal);
          request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const caller = new AbortController();
      const asking = at("/mcp", { method: "POST", headers: bearer, body: "{}", signal: caller.signal });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]!.aborted).toBe(false);
      caller.abort();
      expect((await asking).status).toBe(502);
      expect(signals[0]!.aborted).toBe(true);
      // The caller still there, the company silent: given up after thirty seconds, not before.
      vi.useFakeTimers();
      const waiting = form("/token", { grant_type: "authorization_code", code: "acme.Zx81" });
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(signals[1]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals[1]!.aborted).toBe(true);
      expect((await waiting).status).toBe(502);
      // An answer that has begun is not cut then: its stream goes on past the wait.
      let close!: () => void;
      answer = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
              close = () => {
                controller.enqueue(new TextEncoder().encode("data: 2\n\n"));
                controller.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const streamed = await at("/mcp", { method: "POST", headers: bearer, body: "{}" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inits.at(-1)!.signal!.aborted).toBe(false);
      close();
      expect(await streamed.text()).toBe("data: 1\n\ndata: 2\n\n");
    } finally {
      vi.useRealTimers();
      said.mockRestore();
    }
  });

  it("follows no redirect a company answers, and says when one does not answer", async () => {
    fresh();
    const bearer = { authorization: `Bearer ${unsigned({ sanoma_company: "acme" })}` };
    answer = () => new Response(null, { status: 307, headers: { location: "https://evil.example/mcp" } });
    for (const redirected of [
      await at("/mcp", { method: "POST", headers: bearer, body: "{}" }),
      await form("/token", { grant_type: "authorization_code", code: "acme.Zx81" }),
    ]) {
      expect(redirected.status).toBe(502);
      expect(redirected.headers.has("location")).toBe(false);
      expect(await redirected.json()).toMatchObject({ error: "server_error" });
    }
    // Asked not to follow one, each time, and only the listed host was contacted.
    expect(sent.map((r) => `${new URL(r.url).host} ${r.redirect}`)).toEqual(Array(2).fill("acme.example manual"));
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const down = await at("/mcp", { method: "POST", headers: bearer, body: "{}" });
    expect(down.status).toBe(502);
  });

  it("forwards nothing without its secret, and still says where its metadata is", async () => {
    fresh();
    const bare = made(null);
    const bareAt = (path: string, init: RequestInit = {}) =>
      bare.handle(new Request(`https://${ROUTER_HOST}${path}`, init));
    expect((await bareAt("/.well-known/oauth-authorization-server")).status).toBe(200);
    for (const [path, init] of [
      ["/authorize?company=acme", {}],
      ["/token", { method: "POST" }],
      ["/revoke", { method: "POST" }],
      ["/mcp", { method: "POST", headers: { authorization: `Bearer ${unsigned({ sanoma_company: "acme" })}` } }],
    ] as const) {
      expect((await bareAt(path, init)).status, path).toBe(503);
    }
    expect((await bareAt("/nothing")).status).toBe(404);
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
  });
});

// The three apps.

const hello = defineWorkflow({
  name: "say-hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ to: z.string() }),
  uses: [],
  run: async (_ctx, { to }) => `Hello, ${to}`,
});

/** A company's folder with these people. */
function rootWith(people: string): string {
  const root = mkdtempSync(join(tmpdir(), "sanoma-router-"));
  mkdirSync(join(root, "resources"));
  writeFileSync(join(root, "resources/people.ts"), `import { sanoma } from "sanoma/resources";\n\n${people}\n`);
  return root;
}

/** One company behind the router: its folder, its database, the person who signs in, and (once started) its app. */
interface Company {
  id: string;
  email: string;
  person: string;
  config: SanomaConfig;
  codes: Map<string, string>;
  app?: App;
  client?: SanomaClient;
}
function company(id: string, person: string): Company {
  const email = `${person}@${id}.test`;
  const root = rootWith(`export const ${person} = sanoma.person({ id: "${person}", email: "${email}" });`);
  const databaseUrl = testDatabaseUrl(`router_${id}`);
  return { id, email, person, codes: new Map(), config: { workflows: [hello], connectors: [], root, databaseUrl } };
}
const acme = company("acme", "ada");
const globex = company("globex", "gus");
const urlOf = (c: Company) => c.app!.url;

const companies = collection({
  name: "companies",
  key: "slug",
  fields: { slug: "text", url: "text", status: { enum: ["pending", "live", "stopped"] } },
});
const routerRoot = rootWith(`export const rita = sanoma.person({ id: "rita", email: "rita@router.test" });`);
const routerConfig: SanomaConfig = {
  workflows: [],
  connectors: [],
  collections: [companies],
  root: routerRoot,
  databaseUrl: testDatabaseUrl("router_router"),
  router: { hostname: ROUTER_HOST, companies: { collection: "companies", live: { field: "status", is: "live" } } },
};

/** Every address the router's `fetch` was asked for: since a test last emptied it, and the origins of all of them. */
const contacted: string[] = [];
const origins = new Set<string>();
const noting: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  contacted.push(url);
  origins.add(new URL(url).origin);
  return fetch(input, init);
};
/** A stand-in for claude.ai, which serves Claude Code's metadata document. */
const claudeAi = async (input: string | URL | Request): Promise<Response> =>
  String(input instanceof Request ? input.url : input) === CLAUDE_CODE
    ? Response.json(CLAUDE_CODE_DOCUMENT)
    : new Response("Not found", { status: 404 });

let routerApp: App;
let routerClient: SanomaClient;

beforeAll(async () => {
  for (const c of [acme, globex]) {
    const { databaseUrl } = c.config;
    await prepareDatabase(databaseUrl!);
    await resetStaffSchema(databaseUrl!);
    await prepareBetterAuthStaff(databaseUrl!);
    const login = staffLogin(
      (context) =>
        betterAuthStaffLogin(
          { ...context, sendCode: async (email, code) => void c.codes.set(email, code) },
          { fetchClientMetadata: declaredMetadataFetch(claudeAi) },
        ),
      {},
      // As SANOMA_AGENT_URL, SANOMA_COMPANY and SANOMA_ROUTER_SECRET configure one: the company's
      // own secret, which whoever lists it derives from the router's master.
      routedAgentAddress(`${ROUTER}/mcp`, { company: c.id, secret: await routerSecretFor(MASTER, c.id) }),
    );
    c.app = await startApp(c.config, { port: await freePort(), login });
    c.client = await SanomaClient.connect(c.config);
  }
  routerClient = await SanomaClient.connect(routerConfig);
  for (const record of [
    { slug: "acme", url: urlOf(acme), status: "live" },
    { slug: "globex", url: urlOf(globex), status: "live" },
    // Listed, but not routed to: its URL is acme's, which nothing must reach by this id.
    { slug: "hooli", url: urlOf(acme), status: "pending" },
  ]) {
    await routerClient.call("data.companies.save", { record }, { actor: "rita" });
  }
  routerApp = await startApp(routerConfig, { port: 0, router: { secret: MASTER, fetch: noting } });
}, 120_000);

afterAll(async () => {
  await routerApp?.close();
  await routerClient?.close();
  for (const c of [acme, globex]) {
    await c.app?.close();
    await c.client?.close();
    rmSync(c.config.root!, { recursive: true, force: true });
  }
  rmSync(routerRoot, { recursive: true, force: true });
});

/** What an answer over `node:http` is read as. */
interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * A request to `url` over `node:http`, which says the `Host` and the fetch mode it is given
 * (Node's `fetch` sets both itself): to the router's app under the router's hostname, or a
 * browser's navigation. Never follows a redirect.
 */
function ask(
  url: string,
  {
    method = "GET",
    headers = {},
    body,
    host,
  }: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sending = httpRequest(url, { method, headers: { ...headers, ...(host && { host }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const answered = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value])
            answered.append(name, each);
        }
        resolve({ status: res.statusCode!, headers: answered, text: Buffer.concat(chunks).toString() });
      });
    });
    sending.on("error", reject);
    sending.end(body);
  });
}

/** The router, at a URL its documents name (`https://mcp.router.test/…`) or a path: the router's app, asked under the router's hostname. */
const router = (at: string, init: Parameters<typeof ask>[1] = {}) =>
  ask(new URL(at.replace(ROUTER, ""), routerApp.url).href, { ...init, host: ROUTER_HOST });
const formTo = (at: string, fields: Record<string, string>) =>
  router(at, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
const jsonOf = <T = Record<string, unknown>>(answer: Answer) => JSON.parse(answer.text) as T;

/** A JSON-RPC request to the router's `/mcp`, as an MCP client sends it; its answer as JSON or the last event of a stream. */
async function mcp(method: string, params: Record<string, unknown>, bearer?: string) {
  const answered = await router("/mcp", rpc(method, params, bearer ? { authorization: `Bearer ${bearer}` } : {}));
  return rpcAnswer(answered.status, answered.headers, answered.text);
}

interface Issued {
  access_token: string;
  refresh_token: string;
}

/**
 * What a client and its person do to connect to `c`, everything found from the router: the 401,
 * both metadata documents, the page that asks which company, that company's own sign-in and
 * consent on its own host, then the code for tokens at the router.
 */
async function connect(c: Company) {
  const challenged = await mcp("tools/list", {});
  expect(challenged.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenged.headers.get("www-authenticate") ?? "")?.[1];
  const resource = jsonOf<{ resource: string; authorization_servers: string[] }>(await router(metadataUrl!));
  const [issuer] = resource.authorization_servers;
  const server = jsonOf<Record<string, string>>(await router(`${issuer}/.well-known/oauth-authorization-server`));
  const { verifier, query } = authorizeQuery(CLAUDE_CODE, resource.resource, "s 1");
  // The browser at the router: the page, then the company's id typed into it.
  const page = await router(`${server.authorization_endpoint}?${query}`);
  const chosen = await router(`${server.authorization_endpoint}?${query}&company=${c.id}`);
  expect(chosen.status).toBe(302);
  const authorizeAt = chosen.headers.get("location")!;
  // The browser on the company's own host from here: its authorize, its sign-in, its consent.
  const authorized = await navigate(authorizeAt);
  expect(authorized.status).toBe(302);
  const login = new URL(authorized.headers.get("location")!, urlOf(c));
  const signed = await signInByCode(urlOf(c), c.email, c.codes, login.search.slice(1));
  expect(signed.status).toBe(200);
  const consentAt = signed.next;
  const { consentPage, back } = await allowAt(urlOf(c), consentAt, signed.cookie);
  const code = back.searchParams.get("code")!;
  const exchange = (grant: string) => formTo(server.token_endpoint!, codeForm(grant, verifier, resource.resource));
  return { page, authorizeAt, query, login, consentAt, consentPage, back, code, exchange, server, resource };
}

/** Each company's tokens, from one sign-in each: a sign-in by code is rate limited per address. */
const connected = new Map<Company, Awaited<ReturnType<typeof connect>> & { issued: Issued }>();
async function tokensOf(c: Company) {
  const found = connected.get(c);
  if (found) return found;
  const flow = await connect(c);
  const exchanged = await flow.exchange(flow.code);
  if (exchanged.status !== 200) throw new Error(`the code got no tokens: ${exchanged.status} ${exchanged.text}`);
  const made = { ...flow, issued: jsonOf<Issued>(exchanged) };
  connected.set(c, made);
  return made;
}
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as object;
const refresh = (refresh_token: string) => formTo("/token", refreshForm(refresh_token, `${ROUTER}/mcp`));

describe("a router in front of two companies", () => {
  it("is where a client finds everything: the 401, the metadata, and which company on a page", async () => {
    const flow = await tokensOf(acme);
    expect(flow.resource).toEqual({
      resource: `${ROUTER}/mcp`,
      authorization_servers: [ROUTER],
      bearer_methods_supported: ["header"],
    });
    expect(flow.server).toMatchObject({
      issuer: ROUTER,
      authorization_endpoint: `${ROUTER}/authorize`,
      token_endpoint: `${ROUTER}/token`,
      revocation_endpoint: `${ROUTER}/revoke`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(flow.server).not.toHaveProperty("jwks_uri");
    expect(flow.page.status).toBe(200);
    expect(flow.page.text).toContain("Which company?");
    expect(flow.page.headers.get("x-frame-options")).toBe("DENY");
    // The redirect is to the company's own authorize, the client's query as it came, the resource the router's.
    expect(flow.authorizeAt).toBe(`${urlOf(acme)}/auth/better-auth/oauth2/authorize?${flow.query}`);
  });

  it("leaves the sign-in and the consent to the company, on its own host, and its code and tokens name it", async () => {
    const { login, consentAt, consentPage, back, code, issued } = await tokensOf(acme);
    expect(login.origin + login.pathname).toBe(`${urlOf(acme)}/auth/login`);
    expect(consentAt.origin + consentAt.pathname).toBe(`${urlOf(acme)}/auth/consent`);
    expect(consentPage).toContain("act for you?");
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("iss")).toBe(ROUTER);
    expect(back.searchParams.get("state")).toBe("s 1");
    expect(code).toMatch(/^acme\./);
    expect(issued.refresh_token).toMatch(/^acme\./);
    expect(claimsOf(issued.access_token)).toMatchObject({
      iss: ROUTER,
      aud: `${ROUTER}/mcp`,
      azp: CLAUDE_CODE,
      sanoma_agent: "claude-code",
      sanoma_company: "acme",
    });
    // The company itself serves no metadata for the router's issuer, and names the router's in its own 401.
    expect((await fetch(`${urlOf(acme)}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const direct = await fetch(`${urlOf(acme)}/mcp`, { method: "POST", body: "{}" });
    expect(direct.status).toBe(401);
    expect(direct.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ROUTER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("carries tools/list and a start_run to the company the token names, where the run is recorded", async () => {
    for (const [here, other] of [
      [acme, globex],
      [globex, acme],
    ] as const) {
      const { issued } = await tokensOf(here);
      const listed = await mcp("tools/list", {}, issued.access_token);
      expect(listed.status, here.id).toBe(200);
      expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain("start_run");
      const started = await mcp(
        "tools/call",
        { name: "start_run", arguments: { workflow: "say-hello", input: { to: here.id } } },
        issued.access_token,
      );
      expect(started.body.result.isError, JSON.stringify(started.body)).toBeFalsy();
      const { runId } = started.body.result.structuredContent as { runId: string };
      expect((await here.client!.run(runId))?.startedBy).toEqual({
        id: "claude-code",
        groups: ["agents"],
        onBehalfOf: here.person,
      });
      expect(await other.client!.run(runId)).toBeUndefined();
    }
  });

  it("refuses at the company a token whose tag was forged: sent to globex, signed by acme", async () => {
    const { issued } = await tokensOf(acme);
    await tokensOf(globex);
    contacted.length = 0;
    const forged = await mcp("tools/list", {}, retagged(issued.access_token, "globex"));
    // The router believed the tag, and globex's own sign-in refused the token.
    expect(contacted).toEqual([`${urlOf(globex)}/mcp`]);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    // Nor does a code or a refresh token retagged get anything from the other company.
    const moved = await refresh(issued.refresh_token.replace(/^acme\./, "globex."));
    expect(moved.status).toBe(400);
    expect(contacted.at(-1)).toBe(`${urlOf(globex)}/auth/better-auth/oauth2/token`);
    // The token and the refresh token are still good where they were issued.
    expect((await mcp("tools/list", {}, issued.access_token)).status).toBe(200);
  });

  it("refreshes and revokes through the router, by the refresh token's tag", async () => {
    const flow = await tokensOf(acme);
    contacted.length = 0;
    const renewed = await refresh(flow.issued.refresh_token);
    expect(renewed.status, renewed.text).toBe(200);
    const next = jsonOf<Issued>(renewed);
    expect(next.refresh_token).toMatch(/^acme\./);
    expect(claimsOf(next.access_token)).toMatchObject({ iss: ROUTER, sanoma_company: "acme" });
    expect((await mcp("tools/list", {}, next.access_token)).status).toBe(200);
    const revoked = await formTo(flow.server.revocation_endpoint!, {
      token: next.refresh_token,
      client_id: CLAUDE_CODE,
    });
    expect(revoked.status).toBe(200);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    expect(new Set(contacted.map((url) => new URL(url).origin))).toEqual(new Set([urlOf(acme)]));
    flow.issued = { ...next, refresh_token: "" };
  });

  it("refuses a company it does not list, says one it lists as not live is not available, and contacts nobody for either", async () => {
    contacted.length = 0;
    const page = await router("/authorize?company=initech&client_id=x");
    expect(page.status).toBe(404);
    expect(page.text).toContain("No company with that id is connected here");
    const refused = await mcp("tools/list", {}, unsigned({ sanoma_company: "initech" }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    const token = await formTo("/token", { grant_type: "authorization_code", code: "initech.Zx81" });
    expect(token.status).toBe(400);
    expect(jsonOf(token)).toMatchObject({ error: "invalid_grant" });
    // Listed, and not live: the client is asked to come back, and keeps what it holds.
    const pending = await router("/authorize?company=hooli&client_id=x");
    expect(pending.status).toBe(503);
    expect(pending.text).toContain("That company is not available right now");
    for (const held of [
      await router("/mcp", rpc("tools/list", {}, { authorization: `Bearer ${unsigned({ sanoma_company: "hooli" })}` })),
      await formTo("/token", { grant_type: "authorization_code", code: "hooli.Zx81" }),
      await formTo("/token", { grant_type: "refresh_token", refresh_token: "hooli.Rt" }),
      await formTo("/revoke", { token: "hooli.Rt", client_id: CLAUDE_CODE }),
    ]) {
      expect(held.status).toBe(503);
      expect(held.headers.get("retry-after")).toBe("60");
      expect(jsonOf(held)).toMatchObject({ error: "temporarily_unavailable" });
    }
    expect(contacted).toEqual([]);
  });

  it("serves nothing but its routes on its hostname, and none of them on the app's own", async () => {
    for (const path of ["/", "/healthz", "/auth/login", "/api/token/redeem", "/assets/x.js", "/_serverFn/x"]) {
      expect((await router(path)).status, path).toBe(404);
    }
    // The app's own host is the app's: no page that asks which company, no router's metadata.
    expect((await fetch(`${routerApp.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${routerApp.url}/authorize`)).text()).not.toContain("Which company?");
    expect((await fetch(`${routerApp.url}/.well-known/oauth-authorization-server`)).status).not.toBe(200);
  });

  it("contacted, in all of this, only the two companies it lists as live", () => {
    expect(origins).toEqual(new Set([urlOf(acme), urlOf(globex)]));
  });
});
