import { hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "sanoma/workflows";
import { testDatabaseUrl } from "sanoma/testing";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareBetterAuth } from "../src/instance.ts";
import { betterAuthLogin } from "../src/login.ts";

const databaseUrl = testDatabaseUrl("better_auth");
/** The key the app derives for a login named `purpose` from `SANOMA_SECRETS_KEY` (vitest sets one for the run). */
const keyFor = (purpose: string) =>
  Buffer.from(hkdfSync("sha256", process.env.SANOMA_SECRETS_KEY!, "", purpose, 32)).toString("hex");
const SITE = "http://account.localhost:5173";
/** The app's pool, as its client holds it: what every half here runs on. */
const pool = new Pool({ connectionString: databaseUrl });
const context: LoginContext = {
  database: async () => pool,
  key: keyFor("login better-auth"),
  secrets: async () => new Map(),
  // Locally and hosted at once: one Better Auth for each scheme.
  origins: ["http://account.localhost:*", "https://account.example"],
};

/** `prepareBetterAuth` as another worker's process has it: its own memory of what it migrated. */
async function freshPrepare(): Promise<typeof prepareBetterAuth> {
  vi.resetModules();
  return (await import("../src/instance.ts")).prepareBetterAuth;
}

/** The addresses the rate limit's table counts, from its keys. */
async function rateLimits(): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ key: string }>("SELECT key FROM better_auth.rate_limit");
    return rows.map((row) => row.key.split("|")[0] ?? "");
  } finally {
    await client.end();
  }
}

/** The schema's tables once prepared, as `information_schema` lists them. */
const TABLES = ["account", "rate_limit", "session", "user", "verification"];

async function tables(): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'better_auth' ORDER BY 1",
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

/**
 * A request from the site's page in a browser: its Host, its Origin, a client address of its own
 * (rate limits are per address); a POST with a body, or to sign out (with none, as the app's own).
 */
function request(
  path: string,
  init: { body?: unknown; cookie?: string; host?: string; origin?: string; ip?: string } = {},
): Request {
  const host = init.host ?? "account.localhost:5173";
  const headers = new Headers({
    host,
    origin: init.origin ?? SITE,
    [CLIENT_IP_HEADER]: init.ip ?? `10.0.0.${nextIp++}`,
  });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://${host}${path}`, {
    method: init.body === undefined && !path.endsWith("sign-out") ? "GET" : "POST",
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}
let nextIp = 1;

/** The session cookie a response sets, as `name=value` for the next request; empty for none. */
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/** A new visitor signed up through `half` on the site's page at `host`: its credentials, the answer and its cookie. */
async function signUp(half: LoginHalf, host?: string) {
  const email = `${randomUUID()}@example.com`;
  const password = randomBytes(12).toString("base64");
  const response = (await half.handle(
    request("/auth/better-auth/sign-up/email", {
      body: { email, password, name: "Ada" },
      ...(host && { host, origin: `https://${host}` }),
    }),
  ))!;
  return { email, password, response, cookie: cookieOf(response) };
}

beforeAll(async () => {
  const admin = new Client({
    connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href,
  });
  await admin.connect();
  const name = new URL(databaseUrl).pathname.slice(1);
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // The schema and its journal: a database as the worker first finds it.
  await client.query("DROP SCHEMA IF EXISTS better_auth CASCADE");
  await client.query("DROP TABLE IF EXISTS drizzle.__drizzle_migrations_better_auth");
  await client.end();
});

afterAll(() => pool.end());

describe("login", () => {
  it("refuses a schema from before the migrations, naming the drop that resets it", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // As a release on Better Auth's own migrations left it: the schema, no journal.
      await client.query('CREATE SCHEMA better_auth; CREATE TABLE better_auth."user" (id text PRIMARY KEY)');
      await expect((await freshPrepare())(databaseUrl)).rejects.toThrow(/DROP SCHEMA better_auth CASCADE/);
    } finally {
      await client.query("DROP SCHEMA better_auth CASCADE");
      await client.end();
    }
  });

  it("waits, at its first use, until the worker prepared the schema, and never makes it", async () => {
    const verifying = betterAuthLogin(context).verify(request("/"));
    await delay(1500);
    expect(await tables()).toEqual([]);
    await (
      await freshPrepare()
    )(databaseUrl);
    expect(await verifying).toBeNull();
    expect(await tables()).toEqual(TABLES);
  });

  it("is prepared by the worker: schema better_auth and its tables, from two workers at once", async () => {
    const first = await freshPrepare();
    const second = await freshPrepare();
    expect(first).not.toBe(second);
    await Promise.all([first(databaseUrl), second(databaseUrl)]);
    expect(await tables()).toEqual(TABLES);
  });

  it("is prepared again on the migrated schema, the same tables", async () => {
    await (
      await freshPrepare()
    )(databaseUrl);
    expect(await tables()).toEqual(TABLES);
  });

  it("runs on whichever pool the app gives, an instance per pool, on the one set of tables", async () => {
    // As a Worker gives it: a pool per request, each ended after.
    const pools = [new Pool({ connectionString: databaseUrl }), new Pool({ connectionString: databaseUrl })];
    const given: Pool[] = [];
    const half = betterAuthLogin({ ...context, database: async () => given[given.push(pools.shift() ?? pool) - 1]! });
    const { cookie } = await signUp(half);
    expect(given).toHaveLength(1);
    const seen = await half.verify(request("/", { cookie }));
    expect(seen?.subject).toBeDefined();
    expect(given).toHaveLength(2);
    expect(pools).toEqual([]);
    await Promise.all(given.map((p) => p.end()));
  });

  it("refuses a context without the app's key, and an origin that is more than a scheme and a host", () => {
    expect(() => betterAuthLogin({ ...context, key: undefined as unknown as string })).toThrow(/no key/);
    expect(() => betterAuthLogin({ ...context, origins: ["https://account.example/sign-in"] })).toThrow(
      /a scheme and a host alone/,
    );
  });
});

describe("the login half", () => {
  let half: LoginHalf;
  beforeAll(async () => {
    half = betterAuthLogin(context);
  });

  it("answers its own routes only, and a host outside the site's with 421", async () => {
    expect(await half.handle(request("/sites/account"))).toBeUndefined();
    expect(await half.handle(request("/auth/better-authx/ok"))).toBeUndefined();
    expect((await half.handle(request("/auth/better-auth/ok")))?.status).toBe(200);
    const foreign = await half.handle(request("/auth/better-auth/ok", { host: "evil.example" }));
    expect(foreign?.status).toBe(421);
    await expect(half.verify(request("/", { host: "evil.example" }))).rejects.toThrow(/not one of the site's hosts/);
    expect(half.signOut).toBe("/auth/better-auth/sign-out");
  });

  it("says no one without a cookie, or with a garbage one", async () => {
    expect(await half.verify(request("/"))).toBeNull();
    expect(await half.verify(request("/", { cookie: "better-auth.session_token=garbage.garbage" }))).toBeNull();
  });

  it("signs up, in and out by email and password, with a host-only, HttpOnly, Lax cookie", async () => {
    const { email, password, response, cookie: first } = await signUp(half);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    const [setCookie] = response.headers.getSetCookie();
    expect(setCookie).toMatch(/^better-auth\.session_token=/);
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).not.toMatch(/; Domain=/i);
    expect(setCookie).not.toMatch(/; Secure/i);
    expect(await half.verify(request("/", { cookie: first }))).toEqual({ subject: user.id });

    const wrong = (await half.handle(
      request("/auth/better-auth/sign-in/email", { body: { email, password: "nope" } }),
    ))!;
    expect(wrong.status).toBe(401);

    const signIn = (await half.handle(request("/auth/better-auth/sign-in/email", { body: { email, password } })))!;
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    expect(await half.verify(request("/", { cookie }))).toEqual({ subject: user.id });

    // The app's Sign out button POSTs no body.
    const signOut = (await half.handle(request("/auth/better-auth/sign-out", { cookie })))!;
    expect(signOut.status).toBe(200);
    expect(await half.verify(request("/", { cookie }))).toBeNull();
  });

  it("sets a Secure cookie on the site's https host, and a session there is not one on its http host", async () => {
    const host = "account.example";
    const { response, cookie } = await signUp(half, host);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toMatch(/^__Secure-better-auth\.session_token=.*; Secure/i);
    expect(await half.verify(request("/", { cookie, host }))).not.toBeNull();
    expect(await half.verify(request("/", { cookie }))).toBeNull();
  });

  it("takes a session as its own only under the key it signed it with", async () => {
    const { cookie } = await signUp(half);
    const other = betterAuthLogin({ ...context, key: keyFor("login another") });
    expect(await other.verify(request("/", { cookie }))).toBeNull();
    expect(await half.verify(request("/", { cookie }))).not.toBeNull();
  });

  it("refuses a request with a cookie from another origin", async () => {
    const { cookie } = await signUp(half);
    const forged = await half.handle(request("/auth/better-auth/sign-out", { cookie, origin: "http://evil.example" }));
    expect(forged?.status).toBe(403);
    expect(await half.verify(request("/", { cookie }))).not.toBeNull();
  });

  it("limits sign-in attempts per client address, in a table every instance shares", async () => {
    const body = { email: "no@example.com", password: "wrong-password" };
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await half.handle(request("/auth/better-auth/sign-in/email", { body, ip: "10.9.9.9" })))?.status);
    }
    expect(statuses).toEqual([401, 401, 401]);
    // The fourth try from the same address is refused by another instance, which only the table tells about the first three.
    const other = betterAuthLogin(context);
    const fourth = await other.handle(request("/auth/better-auth/sign-in/email", { body, ip: "10.9.9.9" }));
    expect(fourth?.status).toBe(429);
    const another = await half.handle(request("/auth/better-auth/sign-in/email", { body, ip: "10.9.9.10" }));
    expect(another?.status).toBe(401);
    expect(await rateLimits()).toContain("10.9.9.9");
  });
});

describe("the login half with a sender", () => {
  const codes = new Map<string, string>();
  let half: LoginHalf;
  beforeAll(async () => {
    half = betterAuthLogin({ ...context, sendCode: async (email, code) => void codes.set(email, code) });
  });

  it("offers the code beside the password", () => {
    expect(half.methods).toEqual(["password", "code"]);
  });

  it("signs anyone in by a code mailed to them, and says their email, verified", async () => {
    const email = `${randomUUID()}@example.com`;
    const sent = (await half.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } }),
    ))!;
    expect(sent.status).toBe(200);
    const code = codes.get(email)!;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = (await half.handle(
      request("/auth/better-auth/sign-in/email-otp", { body: { email, otp: code === "000000" ? "111111" : "000000" } }),
    ))!;
    expect(wrong.status).toBe(400);
    const signIn = (await half.handle(request("/auth/better-auth/sign-in/email-otp", { body: { email, otp: code } })))!;
    expect(signIn.status).toBe(200);
    const verified = await half.verify(request("/", { cookie: cookieOf(signIn) }));
    expect(verified).toEqual({ subject: expect.any(String), email });
  });

  it("has no code routes without a sender", async () => {
    const plain = betterAuthLogin(context);
    expect(plain.methods).toEqual(["password"]);
    const sent = await plain.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", {
        body: { email: "a@example.com", type: "sign-in" },
      }),
    );
    expect(sent?.status).toBe(404);
  });
});

/** The tokens kept for the GitHub account `id`, as the account table has them. */
async function tokensOf(id: number) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sql = `SELECT access_token, refresh_token FROM better_auth.account
      WHERE provider_id = 'github' AND account_id = $1`;
    return (await client.query(sql, [String(id)])).rows;
  } finally {
    await client.end();
  }
}

/** A JSON answer, as GitHub gives one. */
const answer = (body: unknown, status = 200) => Response.json(body, { status });

describe("the login half with the company's GitHub client", () => {
  const codes = new Map<string, string>();
  /** GitHub's side: each code it handed out, the token it is worth, and whose account that is (its email verified unless said). */
  const github = new Map<string, { token: string; id: number; login: string; email: string; verified?: boolean }>();
  let half: LoginHalf;
  beforeAll(async () => {
    const fetch = globalThis.fetch;
    // GitHub's three endpoints the link takes: the token, the user and their emails; anything else as it is.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
      const holder = [...github.values()].find((g) => g.token === bearer);
      if (url.href === "https://github.com/login/oauth/access_token") {
        const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
        const user = github.get(code);
        return answer(user ? { access_token: user.token, token_type: "bearer", scope: "" } : { error: "bad_code" });
      }
      if (url.href === "https://api.github.com/user")
        return holder ? answer({ id: holder.id, login: holder.login, name: null, email: null }) : answer({}, 401);
      if (url.href === "https://api.github.com/user/emails")
        return holder
          ? answer([{ email: holder.email, primary: true, verified: holder.verified ?? true }])
          : answer({}, 401);
      return fetch(input, init);
    });
    half = betterAuthLogin({
      ...context,
      sendCode: async (email, code) => void codes.set(email, code),
      social: { github: { clientId: "client-id", clientSecret: "client-secret" } },
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  /** A visitor signed in by an email code (to `email`, a new one by default): their email and session cookie. */
  async function signedIn(email = `${randomUUID()}@example.com`) {
    await half.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } }),
    );
    const signIn = (await half.handle(
      request("/auth/better-auth/sign-in/email-otp", { body: { email, otp: codes.get(email)! } }),
    ))!;
    return { email, cookie: cookieOf(signIn) };
  }

  /**
   * Sends the visitor with `cookie` to GitHub to link it (none: someone signed out, to sign in),
   * and answers GitHub's redirect back with `code`, the account it stands for.
   */
  async function viaGitHub(code: string, cookie?: string) {
    const started = (await half.handle(
      request(`/auth/better-auth/${cookie ? "link-social" : "sign-in/social"}`, {
        ...(cookie && { cookie }),
        body: { provider: "github", callbackURL: "/account" },
      }),
    ))!;
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${SITE}/auth/better-auth/callback/github`);
    // The state is bound to this browser by a cookie of its own, besides the session's.
    const cookies = [...(cookie ? [cookie] : []), ...started.headers.getSetCookie().map((c) => c.split(";")[0])];
    const query = new URLSearchParams({ code, state: authorize.searchParams.get("state")! });
    return (await half.handle(request(`/auth/better-auth/callback/github?${query}`, { cookie: cookies.join("; ") })))!;
  }

  /** Who the session cookie `cookie` signs in, or null. */
  const whoIs = (cookie: string) => half.verify(request("/", { cookie }));

  it("offers GitHub beside the password and the code", () => {
    expect(half.methods).toEqual(["password", "code", "github"]);
  });

  it("links a signed-in visitor's GitHub account, whatever its email, and says their login", async () => {
    const { email, cookie } = await signedIn();
    const ada = { token: "gho_one", id: 4101, login: "Ada-Lovelace", email: "ada@users.github.test" };
    github.set("code-1", ada);
    const back = await viaGitHub("code-1", cookie);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/account");
    expect(await whoIs(cookie)).toEqual({
      subject: expect.any(String),
      email,
      github: "Ada-Lovelace",
    });
    // The page reads it from the session, as `@login`.
    const session = (await half.handle(request("/auth/better-auth/get-session", { cookie })))!;
    expect(((await session.json()) as { user: { github?: string } }).user.github).toBe("Ada-Lovelace");
    // Signed out, the linked GitHub account signs them in, whatever its email.
    github.set("code-1b", { ...ada, token: "gho_one_b" });
    const signIn = await viaGitHub("code-1b");
    expect(await whoIs(cookieOf(signIn))).toEqual(await whoIs(cookie));
  });

  it("links one GitHub account to one visitor only", async () => {
    const first = await signedIn();
    const grace = { token: "gho_two", id: 4102, login: "grace", email: "grace@users.github.test" };
    github.set("code-2", grace);
    expect((await viaGitHub("code-2", first.cookie)).headers.get("location")).toBe("/account");
    const second = await signedIn();
    github.set("code-3", grace);
    const refused = await viaGitHub("code-3", second.cookie);
    expect(refused.headers.get("location")).toMatch(/error=account_already_linked_to_different_user/);
    expect((await whoIs(second.cookie))?.github).toBeUndefined();
  });

  it("keeps one GitHub account per visitor, its login fresh at each link, and none of its tokens", async () => {
    const { cookie } = await signUp(half);
    const linus = { token: "gho_five", id: 4105, login: "linus", email: "linus@users.github.test" };
    github.set("code-5", linus);
    expect((await viaGitHub("code-5", cookie)).headers.get("location")).toBe("/account");
    expect(await tokensOf(4105)).toEqual([{ access_token: null, refresh_token: null }]);
    // Linked again after a rename: the same account, its new login.
    github.set("code-6", { ...linus, token: "gho_six", login: "linus-t" });
    await viaGitHub("code-6", cookie);
    expect((await whoIs(cookie))?.github).toBe("linus-t");
    expect(await tokensOf(4105)).toEqual([{ access_token: null, refresh_token: null }]);
    // Another GitHub account is refused.
    github.set("code-7", { token: "gho_seven", id: 4107, login: "other", email: "other@users.github.test" });
    expect((await viaGitHub("code-7", cookie)).headers.get("location")).toMatch(/error=unable_to_link_account/);
    expect((await whoIs(cookie))?.github).toBe("linus-t");
    // Unlinked (the visitor keeps their password), it is no longer theirs.
    const listed = (await half.handle(request("/auth/better-auth/list-accounts", { cookie })))!;
    const accounts = (await listed.json()) as { id: string; providerId: string }[];
    const linked = accounts.find((a) => a.providerId === "github")!;
    const unlink = await half.handle(
      request("/auth/better-auth/unlink-account", { cookie, body: { accountId: linked.id } }),
    );
    expect(unlink?.status).toBe(200);
    expect((await whoIs(cookie))?.github).toBeUndefined();
  });

  it("signs a new visitor up with GitHub, says their login and verified email, and keeps no token", async () => {
    const hopper = { token: "gho_four", id: 4104, login: "hopper", email: "hopper@users.github.test" };
    github.set("code-4", hopper);
    const back = await viaGitHub("code-4");
    expect(back.headers.get("location")).toBe("/account");
    const visitor = await whoIs(cookieOf(back));
    expect(visitor).toEqual({ subject: expect.any(String), email: hopper.email, github: "hopper" });
    expect(await tokensOf(4104)).toEqual([{ access_token: null, refresh_token: null }]);
    // Again, the same account.
    github.set("code-8", { ...hopper, token: "gho_eight" });
    const again = await viaGitHub("code-8");
    expect(await whoIs(cookieOf(again))).toEqual(visitor);
  });

  it("signs a visitor in by code and by GitHub of the same verified email into one account", async () => {
    const turing = { token: "gho_nine", id: 4109, login: "turing", email: `${randomUUID()}@example.com` };
    const byCode = await signedIn(turing.email);
    github.set("code-9", turing);
    const back = await viaGitHub("code-9");
    expect(back.headers.get("location")).toBe("/account");
    const visitor = { subject: (await whoIs(byCode.cookie))!.subject, email: turing.email, github: "turing" };
    expect(await whoIs(cookieOf(back))).toEqual(visitor);
    expect(await whoIs(byCode.cookie)).toEqual(visitor);
    // A second GitHub account of that email joins it no more than a link would.
    github.set("code-13", { ...turing, token: "gho_thirteen", id: 4113, login: "turing-2" });
    const second = await viaGitHub("code-13");
    expect(second.headers.get("location")).toMatch(/error=unable_to_link_account/);
    expect(await whoIs(byCode.cookie)).toEqual(visitor);
  });

  it("joins no account by an email GitHub has not verified, or one the account has not", async () => {
    // GitHub's email unverified: not the code-login visitor's account of that email.
    const mallory = { token: "gho_ten", id: 4110, login: "mallory", email: `${randomUUID()}@example.com` };
    const byCode = await signedIn(mallory.email);
    github.set("code-10", { ...mallory, verified: false });
    const refused = await viaGitHub("code-10");
    expect(refused.headers.get("location")).toMatch(/error=account_not_linked/);
    expect(refused.headers.getSetCookie().some((c) => c.includes("session_token="))).toBe(false);
    expect((await whoIs(byCode.cookie))?.github).toBeUndefined();
    // The account's email unverified (signed up by password): not that account either.
    const { email, cookie } = await signUp(half);
    github.set("code-11", { token: "gho_eleven", id: 4111, login: "eve", email });
    const unproven = await viaGitHub("code-11");
    expect(unproven.headers.get("location")).toMatch(/error=account_not_linked/);
    expect((await whoIs(cookie))?.github).toBeUndefined();
  });

  it("signs a visitor up by an unverified GitHub email without saying it, until a code proves it", async () => {
    const email = `${randomUUID()}@example.com`;
    github.set("code-12", { token: "gho_twelve", id: 4112, login: "unproven", email, verified: false });
    const back = await viaGitHub("code-12");
    expect(back.headers.get("location")).toBe("/account");
    const visitor = await whoIs(cookieOf(back));
    expect(visitor).toEqual({ subject: expect.any(String), github: "unproven" });
    // Whoever proves the email by a code takes the account, without the GitHub account that did not.
    const byCode = await signedIn(email);
    expect(await whoIs(byCode.cookie)).toEqual({ subject: visitor!.subject, email });
    expect(await whoIs(cookieOf(back))).toBeNull();
  });

  it("never takes a GitHub login a visitor gives, nor a redirect off the site", async () => {
    const email = `${randomUUID()}@example.com`;
    const refused = (await half.handle(
      request("/auth/better-auth/sign-up/email", {
        body: { email, password: randomBytes(12).toString("base64"), name: "Eve", github: "Ada-Lovelace" },
      }),
    ))!;
    expect(refused.status).toBe(400);
    const { cookie } = await signedIn();
    const away = await half.handle(
      request("/auth/better-auth/link-social", {
        cookie,
        body: { provider: "github", callbackURL: "https://evil.example/" },
      }),
    );
    expect(away?.status).toBe(403);
    const query = await half.handle(
      request("/auth/better-auth/callback/github?callbackURL=//evil.example", { cookie }),
    );
    expect(query?.status).toBe(400);
  });

  it("has no GitHub without the company's client", async () => {
    const plain = betterAuthLogin(context);
    expect(plain.methods).toEqual(["password"]);
    const { cookie } = await signUp(plain);
    const started = await plain.handle(
      request("/auth/better-auth/link-social", { cookie, body: { provider: "github", callbackURL: "/" } }),
    );
    expect(started?.status).toBe(404);
  });
});
