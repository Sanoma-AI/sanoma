import { createHash, createHmac, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareBetterAuthStaff } from "../src/instance.ts";
import { declaredMetadataFetch } from "../src/oauth.ts";
import { betterAuthStaffLogin } from "../src/staff.ts";
import { CLAUDE_CODE, CLAUDE_CODE_DOCUMENT, cookieOf, resetStaffSchema } from "./staff-helpers.ts";

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
/** Another client's, which no agent declares. */
const UNDECLARED = "https://elsewhere.example/oauth/client.json";
/** A declared client whose own document asks for DPoP-bound tokens (RFC 9449 §5.2). */
const BOUND = "https://bound.example/oauth/client.json";
const REDIRECT = "http://localhost:53682/callback";
/** A declared client that is a site: its redirect an HTTPS address of its own, which no other program answers at. */
const WEB = "https://web.example/oauth/client.json";
const WEB_REDIRECT = "https://web.example/callback";

/** Each document fetched, by URL, and how it was asked to treat a redirect: the stand-in for the network the CIMD plugin reaches. */
const fetched: string[] = [];
const redirects = new Set<RequestInit["redirect"]>();
async function network(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  redirects.add(init?.redirect);
  if (url === CLAUDE_CODE) return Response.json(CLAUDE_CODE_DOCUMENT, { headers: { "cache-control": "max-age=3600" } });
  if (url === BOUND)
    return Response.json({ ...CLAUDE_CODE_DOCUMENT, client_id: BOUND, dpop_bound_access_tokens: true });
  if (url === WEB) return Response.json({ ...CLAUDE_CODE_DOCUMENT, client_id: WEB, redirect_uris: [WEB_REDIRECT] });
  if (url === "https://claude.ai/oauth/moved")
    return new Response(null, { status: 302, headers: { location: CLAUDE_CODE } });
  return new Response("Not found", { status: 404 });
}

/** Which agent stands for which client, as the people files say: changed by a test to undeclare one. */
const agents = new Map([
  [CLAUDE_CODE, "claude-code"],
  [BOUND, "bound"],
  [WEB, "web-bot"],
  ["https://claude.ai/oauth/moved", "moved"],
]);
/** Runs `run` while `agent` stands for `client` (no agent, undefined), then puts the declaration back as it was. */
async function withAgent<T>(client: string, agent: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = agents.get(client);
  if (agent === undefined) agents.delete(client);
  else agents.set(client, agent);
  try {
    return await run();
  } finally {
    if (before === undefined) agents.delete(client);
    else agents.set(client, before);
  }
}
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

/** A JWT's header or payload, as it is written: JSON, base64url. */
const jsonPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

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

/** The identifiers of the provider's resource rows, sorted. */
const resourceRows = async () =>
  (await pool.query<{ identifier: string }>("SELECT identifier FROM better_auth_staff.oauth_resource")).rows
    .map((row) => row.identifier)
    .toSorted();

/** The token endpoint, as a client calls it: a form, no Origin, no cookie; `headers` besides, when it sends any. */
async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const asking = request("/auth/better-auth/oauth2/token", { form, origin: null });
  for (const [name, value] of Object.entries(headers)) asking.headers.set(name, value);
  const answered = (await half.handle(asking))!;
  return { status: answered.status, body: (await answered.json()) as Record<string, string> };
}

/** A code for tokens at the token endpoint, with its PKCE verifier, as `client` (Claude Code unless said) sends it. */
const exchange = (
  code: string,
  verifier: string,
  client = CLAUDE_CODE,
  headers: Record<string, string> = {},
  redirect = REDIRECT,
) =>
  token(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client,
      code_verifier: verifier,
      resource: MCP,
    },
    headers,
  );

/** A refresh at the token endpoint, as `client` (Claude Code unless said) sends one. */
const refreshWith = (refresh_token: string, client = CLAUDE_CODE) =>
  token({ grant_type: "refresh_token", refresh_token, client_id: client, resource: MCP });

/** What a login's `bearer` (this one's unless said) says of a client's request to `/mcp` with the token `bearer`, or with none. */
const bearerOf = (bearer?: string, at: { host?: string; login?: LoginHalf; path?: string } = {}) =>
  (at.login ?? half).bearer!(
    request(at.path ?? "/mcp", { origin: null, ...(bearer && { bearer }), ...(at.host && { host: at.host }) }),
  );

/** The whole flow for a client, Claude Code unless said: authorize, sign in by code, consent, the code for tokens. */
async function connect(client = CLAUDE_CODE, redirect = REDIRECT) {
  const { verifier, challenge } = pkce();
  const asked = (await half.handle(request(authorizePath(client, challenge, { redirect_uri: redirect }))))!;
  expect(asked.status).toBe(302);
  const login = asked.headers.get("location")!;
  const { cookie, next } = await signInFrom(login);
  const back = next.startsWith(redirect) ? new URL(next) : await consent(next, cookie);
  return { cookie, back, ...(await exchange(back.searchParams.get("code")!, verifier, client, {}, redirect)) };
}

/** Where an authorize of `client`'s sends the person signed in with `cookie`: a page of the login's by its path, or the client's redirect. */
async function sentTo(client: string, redirect: string, cookie: string, extra: Record<string, string> = {}) {
  const { challenge } = pkce();
  const asked = (await half.handle(
    request(authorizePath(client, challenge, { redirect_uri: redirect, ...extra }), { cookie }),
  ))!;
  expect(asked.status).toBe(302);
  const to = new URL(asked.headers.get("location")!, ORIGIN);
  return { to, at: to.origin === ORIGIN ? to.pathname : `${to.origin}${to.pathname}` };
}

beforeAll(async () => {
  await resetStaffSchema(databaseUrl);
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

  it("serves its authorization server metadata where RFC 8414 puts it for its issuer: only what it serves", async () => {
    const answered = (await half.handle(
      request("/.well-known/oauth-authorization-server/auth/better-auth", { origin: null }),
    ))!;
    expect(answered.status).toBe(200);
    // Every field: CIMD, public clients alone, PKCE S256, revocation; no registration,
    // introspection, DPoP or back-channel logout, none of which is served.
    expect(await answered.json()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      revocation_endpoint: `${ISSUER}/oauth2/revoke`,
      jwks_uri: `${ISSUER}/jwks`,
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
  });

  it("serves from each instance the login makes, as a Worker makes one per request: here one per protocol", async () => {
    for (const proto of ["http", "https"]) {
      const path = "/.well-known/oauth-authorization-server/auth/better-auth";
      const asked = new Request(`http://${HOST}${path}`, { headers: { host: HOST, "x-forwarded-proto": proto } });
      const answered = (await half.handle(asked))!;
      expect(answered.status, proto).toBe(200);
      expect(await answered.json(), proto).toMatchObject({ issuer: `${proto}://${HOST}/auth/better-auth` });
    }
  });

  it("lets no shared cache keep a document made from the request's Host and protocol", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/auth/better-auth",
    ]) {
      const answered = (await half.handle(request(path, { origin: null })))!;
      expect(answered.headers.get("cache-control"), path).toMatch(/^private\b/);
      expect(answered.headers.get("vary")?.toLowerCase(), path).toBe("host, x-forwarded-proto");
    }
  });

  it("answers 404 for the discovery documents it does not serve: the issuer has a path", async () => {
    for (const path of [
      "/.well-known/x",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration/auth/better-auth",
      "/.well-known/oauth-protected-resource/elsewhere",
      "/auth/better-auth/.well-known/openid-configuration",
      "/auth/better-auth/.well-known/oauth-authorization-server",
    ]) {
      expect((await half.handle(request(path, { origin: null })))?.status, path).toBe(404);
    }
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
    expect(await bearerOf(body.access_token)).toEqual({
      subject: expect.any(String),
      email: DECLARED,
      client: CLAUDE_CODE,
    });
  });

  it("asks no consent the second time, and rotates the refresh token", async () => {
    const first = await connect();
    const again = await connect();
    expect(again.status).toBe(200);
    const refreshed = await refreshWith(first.body.refresh_token!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(decode(refreshed.body.access_token!).payload.aud).toBe(MCP);
  });

  it("loses the whole chain once a refresh token is used twice", async () => {
    const { body } = await connect();
    const first = await refreshWith(body.refresh_token!);
    expect(first.status).toBe(200);
    // The old one again: someone else holds a copy, so neither copy goes on.
    const replayed = await refreshWith(body.refresh_token!);
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toBe("invalid_grant");
    const next = await refreshWith(first.body.refresh_token!);
    expect(next.status).toBe(400);
    expect(next.body.error).toBe("invalid_grant");
  });

  it("is asked consent again once it stands for another agent than the one consented to", async () => {
    const { cookie } = await connect(WEB, WEB_REDIRECT);
    const where = async () => (await sentTo(WEB, WEB_REDIRECT, cookie)).at;
    expect(await where()).toBe(WEB_REDIRECT);
    expect(await withAgent(WEB, "admin-bot", where)).toBe("/auth/consent");
    expect(await where()).toBe(WEB_REDIRECT);
  });

  it("is asked consent at every sign-in when its redirect is this computer's, which any program there could answer", async () => {
    // RFC 8252 §8.6: a loopback redirect on any port proves nothing of who listens there.
    for (const redirect of [REDIRECT, "http://127.0.0.1:41000/callback"]) {
      const { cookie, status } = await connect(CLAUDE_CODE, redirect);
      expect(status, redirect).toBe(200);
      const again = await sentTo(CLAUDE_CODE, redirect, cookie);
      expect(again.at, redirect).toBe("/auth/consent");
      // Allowed there, it goes on as before.
      expect((await consent(again.to.href, cookie)).searchParams.get("code"), redirect).toEqual(expect.any(String));
      // Asked to show nothing (`prompt=none`), it gets no code either: there is a page to show.
      const silent = await sentTo(CLAUDE_CODE, redirect, cookie, { prompt: "none" });
      expect(silent.to.searchParams.get("code"), redirect).toBeNull();
      expect(silent.to.searchParams.get("error"), redirect).toEqual(expect.any(String));
    }
  });

  it("is asked consent once when its redirect is an HTTPS address of its own", async () => {
    const { cookie, status, back } = await connect(WEB, WEB_REDIRECT);
    expect(status).toBe(200);
    expect(back.origin + back.pathname).toBe(WEB_REDIRECT);
    const again = await sentTo(WEB, WEB_REDIRECT, cookie);
    expect(again.at).toBe(WEB_REDIRECT);
    expect(again.to.searchParams.get("code")).toEqual(expect.any(String));
  });

  it("holds tokens only for the agent their person consented to, whatever its client stands for since", async () => {
    const { body } = await connect();
    expect(decode(body.access_token!).payload.sanoma_agent).toBe("claude-code");
    // The files move the client to another agent: nobody consented to that one.
    await withAgent(CLAUDE_CODE, "admin-bot", async () => {
      expect(await bearerOf(body.access_token)).toBeNull();
      // Nor does a refresh make the old consent the new agent's, asked with the resource or without.
      for (const form of [{ resource: MCP }, {}] as Record<string, string>[]) {
        const refreshed = await token({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token!,
          client_id: CLAUDE_CODE,
          ...form,
        });
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(400);
        expect(refreshed.body.error).toBe("invalid_grant");
        expect(refreshed.body.access_token).toBeUndefined();
      }
    });
    // Mapped back, they are the consented agent's again: a refused refresh used nothing up.
    expect(await bearerOf(body.access_token)).toMatchObject({ client: CLAUDE_CODE });
    const refreshed = await refreshWith(body.refresh_token!);
    expect(refreshed.status).toBe(200);
    expect(decode(refreshed.body.access_token!).payload.sanoma_agent).toBe("claude-code");
  });

  it("is refused a code for tokens once it stands for another agent than the code was given for", async () => {
    const { verifier, challenge } = pkce();
    const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge))))!;
    const { cookie, next } = await signInFrom(asked.headers.get("location")!);
    const back = next.startsWith(REDIRECT) ? new URL(next) : await consent(next, cookie);
    await withAgent(CLAUDE_CODE, "admin-bot", async () => {
      const { status, body } = await exchange(back.searchParams.get("code")!, verifier);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_grant");
      expect(body.access_token).toBeUndefined();
    });
  });

  it("revokes its own refresh token with its client id alone, which is then refused", async () => {
    const { body } = await connect();
    const revoked = (await half.handle(
      request("/auth/better-auth/oauth2/revoke", {
        form: { token: body.refresh_token!, token_type_hint: "refresh_token", client_id: CLAUDE_CODE },
        origin: null,
      }),
    ))!;
    expect(revoked.status).toBe(200);
    const refreshed = await refreshWith(body.refresh_token!);
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
  });

  it("gets a plain Bearer token whether it sends a DPoP proof or binds the code to a key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const proof = () => {
      const signed = `${jsonPart({ typ: "dpop+jwt", alg: "ES256", jwk })}.${jsonPart({
        htm: "POST",
        htu: `${ISSUER}/oauth2/token`,
        jti: randomBytes(16).toString("hex"),
        iat: Math.floor(Date.now() / 1000),
      })}`;
      const signature = sign("sha256", Buffer.from(signed), { key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${signed}.${signature.toString("base64url")}`;
    };
    const { cookie } = await connect();
    const { verifier, challenge } = pkce();
    // The code asked for bound to a key (RFC 9449 §10), the token asked for with a proof.
    const thumbprint = createHash("sha256")
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest("base64url");
    const asked = (await half.handle(
      request(authorizePath(CLAUDE_CODE, challenge, { dpop_jkt: thumbprint }), { cookie }),
    ))!;
    const code = (await consent(asked.headers.get("location")!, cookie)).searchParams.get("code")!;
    const { status, body } = await exchange(code, verifier, CLAUDE_CODE, { dpop: proof() });
    expect(status).toBe(200);
    expect(body.token_type).toMatch(/^bearer$/i);
    expect(decode(body.access_token!).payload.cnf).toBeUndefined();
    expect(await bearerOf(body.access_token)).toMatchObject({ client: CLAUDE_CODE });
    // Its refresh token is no key's either: refreshed with no proof.
    expect((await refreshWith(body.refresh_token!)).status).toBe(200);
  });

  it("gets a plain Bearer token though its own document asks for DPoP-bound ones", async () => {
    const { status, body } = await connect(BOUND);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.token_type).toMatch(/^bearer$/i);
    expect(decode(body.access_token!).payload.cnf).toBeUndefined();
    expect(await bearerOf(body.access_token)).toMatchObject({ client: BOUND });
    const refreshed = await refreshWith(body.refresh_token!, BOUND);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  });

  it("is refused at consent once no agent declares it any more, though the page was shown", async () => {
    const { cookie } = await connect();
    const { challenge } = pkce();
    const asked = (await half.handle(
      request(authorizePath(CLAUDE_CODE, challenge, { prompt: "consent" }), { cookie }),
    ))!;
    const page = new URL(asked.headers.get("location")!, ORIGIN);
    expect(page.pathname).toBe("/auth/consent");
    await withAgent(CLAUDE_CODE, undefined, async () => {
      const allowed = (await half.handle(
        request("/auth/better-auth/oauth2/consent", {
          body: { accept: true, oauth_query: page.search.slice(1) },
          cookie,
        }),
      ))!;
      expect(allowed.status).toBe(403);
      expect(await allowed.text()).not.toContain("code=");
    });
  });

  it("is not left waiting for a reading of its document another request began and never finished", async () => {
    // The first fetch never answers, nor heeds its abort: a request a Worker cancelled, whose
    // timers and continuations never run again.
    let fetches = 0;
    const stuck = declaredMetadataFetch((input, init) =>
      fetches++ === 0 ? new Promise<Response>(() => undefined) : network(input, init),
    );
    const login = betterAuthStaffLogin(context, { fetchClientMetadata: stuck });
    const asking = () => login.handle(request(authorizePath(CLAUDE_CODE, pkce().challenge)));
    // The clock the login's waits read is the test's; the database's answers take real time.
    const really = setTimeout;
    const until = async (done: () => boolean, seconds: number) => {
      for (let waited = 0; waited < 600 && !done(); waited++) {
        await vi.advanceTimersByTimeAsync(seconds * 1000);
        await new Promise((resolve) => really(resolve, 5));
      }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = asking();
      await until(() => fetches > 0, 0);
      // The next request for the same client, in the same process.
      let answered: Response | undefined;
      const second = asking().then((response) => (answered = response));
      await until(() => answered !== undefined, 1);
      expect(answered?.status).toBe(302);
      // Those after it wait for nothing: the stuck reading is dropped with all it held.
      expect((await asking())?.status).toBe(302);
      expect(fetches).toBe(2);
      await Promise.all([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asking for a redirect its document does not list is told so on a page, never sent there", async () => {
    const { challenge } = pkce();
    const asked = (await half.handle(
      request(authorizePath(CLAUDE_CODE, challenge, { redirect_uri: "https://elsewhere.example/callback" })),
    ))!;
    expect(asked.status).toBe(302);
    const to = new URL(asked.headers.get("location")!, ORIGIN);
    expect(to.origin + to.pathname).toBe(`${ISSUER}/error`);
    const shown = (await half.handle(request(`${to.pathname}${to.search}`, { origin: null })))!;
    expect(shown.status).toBe(400);
    expect(shown.headers.get("content-type")).toContain("text/html");
    expect(shown.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(shown.headers.get("x-frame-options")).toBe("DENY");
    expect(shown.headers.get("cache-control")).toBe("no-store");
    const page = await shown.text();
    expect(page).toContain("invalid_redirect");
    expect(page).toMatch(/again from the agent/i);
    // What the link says is shown as text, whatever it is: anyone can write such a link.
    const forged = (await half.handle(
      request(
        `/auth/better-auth/error?${new URLSearchParams({ error: "<script>alert(1)</script>", error_description: '<img src=x onerror="alert(2)">' })}`,
        { origin: null },
      ),
    ))!;
    const text = await forged.text();
    expect(text).not.toMatch(/<script|<img/);
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // With no OAuth context nothing sends anyone there: a 404 as any unlisted route.
    const plain = betterAuthStaffLogin({ ...context, staff: { ...context.staff!, oauth: undefined } });
    expect((await plain.handle(request("/auth/better-auth/error?error=x", { origin: null })))?.status).toBe(404);
  });

  it("is refused a resource that is not this instance's own /mcp", async () => {
    const { challenge } = pkce();
    for (const resource of ["https://elsewhere.example/mcp", `${ORIGIN}/api/call`]) {
      const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge, { resource }))))!;
      expect(asked.status, resource).toBe(400);
      expect(await asked.text(), resource).toContain(MCP);
    }
  });

  it("gets a host's resource row made only at an authorize that is accepted, never at the token endpoint", async () => {
    const before = await resourceRows();
    const { body } = await connect();
    // The token endpoint, on hosts never asked for: junk grants, and a real refresh token.
    for (const host of ["junk-1.example", "junk-2.example"]) {
      const junk = (await half.handle(
        request("/auth/better-auth/oauth2/token", { form: { grant_type: "nothing" }, origin: null, host }),
      ))!;
      expect(junk.status, host).not.toBe(200);
    }
    const elsewhere = (await half.handle(
      request("/auth/better-auth/oauth2/token", {
        form: {
          grant_type: "refresh_token",
          refresh_token: body.refresh_token!,
          client_id: CLAUDE_CODE,
          resource: "https://junk-3.example/mcp",
        },
        origin: null,
        host: "junk-3.example",
      }),
    ))!;
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.json()).toMatchObject({ error: "invalid_target" });
    // Authorize refused: an undeclared client, another host's resource.
    const { challenge } = pkce();
    const host = "junk-4.example";
    for (const path of [
      authorizePath(UNDECLARED, challenge, { resource: `https://${host}/mcp` }),
      authorizePath(CLAUDE_CODE, challenge, { resource: MCP }),
    ]) {
      expect((await half.handle(request(path, { host })))!.status, path).not.toBe(302);
    }
    expect(await resourceRows()).toEqual(before.includes(MCP) ? before : [...before, MCP].toSorted());
    // Accepted, on a host of its own: its row is there for the provider.
    const own = (await half.handle(
      request(authorizePath(CLAUDE_CODE, challenge, { resource: "https://fresh.example/mcp" }), {
        host: "fresh.example",
      }),
    ))!;
    expect(own.status).toBe(302);
    expect(await resourceRows()).toContain("https://fresh.example/mcp");
  });

  it("is refused once no agent declares it any more: at authorize, the token endpoint and revocation", async () => {
    const { body } = await connect();
    await withAgent(CLAUDE_CODE, undefined, async () => {
      const { challenge } = pkce();
      const asked = (await half.handle(request(authorizePath(CLAUDE_CODE, challenge))))!;
      expect(asked.status).toBe(403);
      const refreshed = await refreshWith(body.refresh_token!);
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe("invalid_client");
      // Nor is it a client at revocation: the provider finds none by that id.
      const revoked = (await half.handle(
        request("/auth/better-auth/oauth2/revoke", {
          form: { token: body.refresh_token!, token_type_hint: "refresh_token", client_id: CLAUDE_CODE },
          origin: null,
        }),
      ))!;
      expect(revoked.status).toBe(400);
      expect(await revoked.json()).toMatchObject({ error: "invalid_client" });
    });
  });
});

describe("an undeclared client", () => {
  it("is refused at authorize, saying where one is declared, before its document is fetched", async () => {
    fetched.length = 0;
    const { challenge } = pkce();
    const asked = (await half.handle(request(authorizePath(UNDECLARED, challenge))))!;
    expect(asked.status).toBe(403);
    expect(asked.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(asked.headers.get("x-frame-options")).toBe("DENY");
    const page = await asked.text();
    expect(page).toContain("resources/people.ts");
    expect(page).toContain(UNDECLARED);
    expect(page).toMatch(/only a client you chose/i);
    // Nothing ready to paste: a link anyone sends names whatever client it likes.
    expect(page).not.toContain("sanoma.agent(");
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
  it("is checked against keys read once, not at every call", async () => {
    const { body } = await connect();
    // Each read of the keys' table, as the adapter asks the pool.
    const reads: string[] = [];
    const ask = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    const query = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text;
      if (text?.includes('"jwks"')) reads.push(text);
      return ask(...args);
    }) as typeof pool.query);
    try {
      // A login of its own, so nothing is kept yet.
      const fresh = betterAuthStaffLogin(context, { fetchClientMetadata: declaredMetadataFetch(network) });
      for (let i = 0; i < 3; i++) {
        expect(await bearerOf(body.access_token, { login: fresh })).toMatchObject({ client: CLAUDE_CODE });
      }
      expect(reads).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
  });

  it("fails, rather than calling the token bad, when its keys cannot be read", async () => {
    const { body } = await connect();
    const down = new Pool({ connectionString: "postgres://postgres@127.0.0.1:1/nothing" });
    try {
      const unread = betterAuthStaffLogin(
        { ...context, database: async () => down },
        { fetchClientMetadata: declaredMetadataFetch(network) },
      );
      await expect(bearerOf(body.access_token, { login: unread })).rejects.toThrow("ECONNREFUSED");
      // A token that is no JWT is refused before anything is read.
      expect(await bearerOf("sca_nothing", { login: unread })).toBeNull();
    } finally {
      await down.end();
    }
  });

  it("is refused for another audience, another issuer, a bad signature or once expired", async () => {
    const { body } = await connect();
    const access = body.access_token!;
    // The same instance's token, for /mcp on another host: neither the audience nor the issuer there.
    expect(await bearerOf(access, { host: "other.example" })).toBeNull();
    // A token another resource of this login was issued for: the same issuer and keys, another audience.
    const other = betterAuthStaffLogin(
      { ...context, staff: { ...context.staff!, oauth: { ...context.staff!.oauth!, resource: "/elsewhere" } } },
      { fetchClientMetadata: declaredMetadataFetch(network) },
    );
    expect(decode(access).payload.aud).toBe(MCP);
    expect(await bearerOf(access, { login: other, path: "/elsewhere" })).toBeNull();
    // One character of the signature changed.
    const [head, payload, signature] = access.split(".");
    const flipped = `${head}.${payload}.${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    expect(await bearerOf(flipped)).toBeNull();
    // Forged: no signature (`alg: none`), and HS256 keyed with the public key (the confusion of
    // an asymmetric key for a shared secret): only the login's own algorithm and keys are taken.
    const { header: realHeader } = decode(access);
    const none = `${jsonPart({ ...realHeader, alg: "none" })}.${payload}.`;
    expect(await bearerOf(none)).toBeNull();
    expect(await bearerOf(`${none}x`)).toBeNull();
    const jwks = (await (await half.handle(request("/auth/better-auth/jwks", { origin: null })))!.json()) as {
      keys: { x: string }[];
    };
    const hs = `${jsonPart({ ...realHeader, alg: "HS256" })}.${payload}`;
    for (const secret of [JSON.stringify(jwks.keys[0]), Buffer.from(jwks.keys[0]!.x, "base64url")]) {
      const forged = `${hs}.${createHmac("sha256", secret).update(hs).digest("base64url")}`;
      expect(await bearerOf(forged)).toBeNull();
    }
    // Signed with a key of the login's, but naming no agent, as a token from before tokens named
    // one: nobody consented to whichever agent the client stands for now.
    const signer = generateKeyPairSync("ed25519");
    const kid = `test-${randomBytes(8).toString("hex")}`;
    await pool.query(
      "INSERT INTO better_auth_staff.jwks (id, public_key, private_key, created_at) VALUES ($1, $2, 'none', to_timestamp(0))",
      [kid, JSON.stringify(signer.publicKey.export({ format: "jwk" }))],
    );
    try {
      const { payload: claims } = decode(access);
      const signedBy = (said: Record<string, unknown>) => {
        const signing = `${jsonPart({ alg: "EdDSA", typ: "at+jwt", kid })}.${jsonPart(said)}`;
        return `${signing}.${sign(null, Buffer.from(signing), signer.privateKey).toString("base64url")}`;
      };
      const fresh = () => betterAuthStaffLogin(context, { fetchClientMetadata: declaredMetadataFetch(network) });
      expect(await bearerOf(signedBy(claims), { login: fresh() })).toMatchObject({ client: CLAUDE_CODE });
      const { sanoma_agent: _agent, ...unnamed } = claims;
      expect(await bearerOf(signedBy(unnamed), { login: fresh() })).toBeNull();
      expect(await bearerOf(signedBy({ ...unnamed, sanoma_agent: "admin-bot" }), { login: fresh() })).toBeNull();
    } finally {
      await pool.query("DELETE FROM better_auth_staff.jwks WHERE id = $1", [kid]);
    }
    // Not a JWT, and no bearer at all.
    expect(await bearerOf("sca_nothing")).toBeNull();
    expect(await bearerOf()).toBeNull();
    // An hour on, the token has expired.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      expect(await bearerOf(access)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(await bearerOf(access)).toMatchObject({ client: CLAUDE_CODE });
  });
});
