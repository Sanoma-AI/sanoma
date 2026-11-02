import { hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "@sanoma-ai/workflows";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuthLogin } from "../src/login.ts";

const databaseUrl = testDatabaseUrl("better_auth");
/** The key the app derives for a login named `purpose` from `SANOMA_SECRETS_KEY` (vitest sets one for the run). */
const keyFor = (purpose: string) =>
  Buffer.from(hkdfSync("sha256", process.env.SANOMA_SECRETS_KEY!, "", purpose, 32)).toString("hex");
const SITE = "http://account.localhost:5173";
const context: LoginContext = {
  databaseUrl,
  key: keyFor("login better-auth"),
  secrets: async () => new Map(),
  // Locally and hosted at once: one Better Auth for each scheme.
  origins: ["http://account.localhost:*", "https://account.example"],
};

/** A fresh copy of the module, whose once-per-process migration has not run: a process of its own. */
async function freshLogin(): Promise<typeof betterAuthLogin> {
  vi.resetModules();
  return (await import("../src/login.ts")).betterAuthLogin;
}

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

/** The session cookie a response sets, as `name=value` for the next request. */
const cookieOf = (response: Response) => response.headers.getSetCookie()[0]?.split(";")[0] ?? "";

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
  await client.query("DROP SCHEMA IF EXISTS better_auth CASCADE");
  await client.end();
});

describe("login", () => {
  it("creates schema better_auth and its tables, from two cold starts at once", async () => {
    const first = await freshLogin();
    const second = await freshLogin();
    expect(first).not.toBe(second);
    const halves = await Promise.all([first(context), second(context)]);
    await Promise.all(halves.map((half) => half.close?.()));
    expect(await tables()).toEqual(["account", "session", "user", "verification"]);
  });

  it("starts again on the migrated schema, the same tables", async () => {
    const half = await (await freshLogin())(context);
    await half.close?.();
    expect(await tables()).toEqual(["account", "session", "user", "verification"]);
  });

  it("refuses a context without the app's key, and an origin that is more than a scheme and a host", async () => {
    await expect(betterAuthLogin({ ...context, key: undefined as unknown as string })).rejects.toThrow(/no key/);
    await expect(betterAuthLogin({ ...context, origins: ["https://account.example/sign-in"] })).rejects.toThrow(
      /a scheme and a host alone/,
    );
  });
});

describe("the login half", () => {
  let half: LoginHalf;
  beforeAll(async () => {
    half = await betterAuthLogin(context);
  });
  afterAll(() => half.close?.());

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
    const other = await betterAuthLogin({ ...context, key: keyFor("login another") });
    try {
      expect(await other.verify(request("/", { cookie }))).toBeNull();
    } finally {
      await other.close?.();
    }
    expect(await half.verify(request("/", { cookie }))).not.toBeNull();
  });

  it("refuses a request with a cookie from another origin", async () => {
    const { cookie } = await signUp(half);
    const forged = await half.handle(request("/auth/better-auth/sign-out", { cookie, origin: "http://evil.example" }));
    expect(forged?.status).toBe(403);
    expect(await half.verify(request("/", { cookie }))).not.toBeNull();
  });

  it("limits sign-in attempts per client address", async () => {
    const body = { email: "no@example.com", password: "wrong-password" };
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await half.handle(request("/auth/better-auth/sign-in/email", { body, ip: "10.9.9.9" })))?.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    const another = await half.handle(request("/auth/better-auth/sign-in/email", { body, ip: "10.9.9.10" }));
    expect(another?.status).toBe(401);
  });
});

describe("the login half with a sender", () => {
  const codes = new Map<string, string>();
  let half: LoginHalf;
  beforeAll(async () => {
    half = await betterAuthLogin({ ...context, sendCode: async (email, code) => void codes.set(email, code) });
  });
  afterAll(() => half.close?.());

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
    const plain = await betterAuthLogin(context);
    try {
      expect(plain.methods).toEqual(["password"]);
      const sent = await plain.handle(
        request("/auth/better-auth/email-otp/send-verification-otp", {
          body: { email: "a@example.com", type: "sign-in" },
        }),
      );
      expect(sent?.status).toBe(404);
    } finally {
      await plain.close?.();
    }
  });
});

/** The tokens kept for the GitHub account `id`, as the account table has them. */
async function tokensOf(id: number) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sql = `SELECT "accessToken" AS access_token, "refreshToken" AS refresh_token FROM better_auth.account
      WHERE "providerId" = 'github' AND "accountId" = $1`;
    return (await client.query(sql, [String(id)])).rows;
  } finally {
    await client.end();
  }
}

/** A JSON answer, as GitHub gives one. */
const answer = (body: unknown, status = 200) => Response.json(body, { status });

describe("the login half with the company's GitHub client", () => {
  const codes = new Map<string, string>();
  /** GitHub's side: each code it handed out, the token it is worth, and whose account that is. */
  const github = new Map<string, { token: string; id: number; login: string; email: string }>();
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
        return holder ? answer([{ email: holder.email, primary: true, verified: true }]) : answer({}, 401);
      return fetch(input, init);
    });
    half = await betterAuthLogin({
      ...context,
      sendCode: async (email, code) => void codes.set(email, code),
      social: { github: { clientId: "client-id", clientSecret: "client-secret" } },
    });
  });
  afterAll(async () => {
    await half.close?.();
    vi.unstubAllGlobals();
  });

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
   * Sends the visitor with `cookie` (none: someone signed out) to GitHub by `route`, and answers
   * GitHub's redirect back with `code`, the account it stands for: linked, or signed in.
   */
  async function viaGitHub(code: string, cookie?: string, route = "link-social") {
    const started = (await half.handle(
      request(`/auth/better-auth/${route}`, {
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

  it("offers GitHub beside the password and the code", () => {
    expect(half.methods).toEqual(["password", "code", "github"]);
  });

  it("links a signed-in visitor's GitHub account, whatever its email, and says their login", async () => {
    const { email, cookie } = await signedIn();
    github.set("code-1", { token: "gho_one", id: 4101, login: "Ada-Lovelace", email: "ada@users.github.test" });
    const back = await viaGitHub("code-1", cookie);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/account");
    expect(await half.verify(request("/", { cookie }))).toEqual({
      subject: expect.any(String),
      email,
      github: "Ada-Lovelace",
    });
    // The page reads it from the session, as `@login`.
    const session = (await half.handle(request("/auth/better-auth/get-session", { cookie })))!;
    expect(((await session.json()) as { user: { github?: string } }).user.github).toBe("Ada-Lovelace");
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
    expect((await half.verify(request("/", { cookie: second.cookie })))?.github).toBeUndefined();
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
    expect((await half.verify(request("/", { cookie })))?.github).toBe("linus-t");
    expect(await tokensOf(4105)).toEqual([{ access_token: null, refresh_token: null }]);
    // Another GitHub account is refused.
    github.set("code-7", { token: "gho_seven", id: 4107, login: "other", email: "other@users.github.test" });
    expect((await viaGitHub("code-7", cookie)).headers.get("location")).toMatch(/error=unable_to_link_account/);
    expect((await half.verify(request("/", { cookie })))?.github).toBe("linus-t");
    // Unlinked (the visitor keeps their password), it is no longer theirs.
    const listed = (await half.handle(request("/auth/better-auth/list-accounts", { cookie })))!;
    const accounts = (await listed.json()) as { id: string; providerId: string }[];
    const linked = accounts.find((a) => a.providerId === "github")!;
    const unlink = await half.handle(
      request("/auth/better-auth/unlink-account", { cookie, body: { accountId: linked.id } }),
    );
    expect(unlink?.status).toBe(200);
    expect((await half.verify(request("/", { cookie })))?.github).toBeUndefined();
  });

  it("signs in with GitHub only a visitor who linked it, and makes no account for anyone else", async () => {
    const hopper = { token: "gho_four", id: 4104, login: "hopper", email: "hopper@users.github.test" };
    github.set("code-4", hopper);
    const refused = await viaGitHub("code-4", undefined, "sign-in/social");
    expect(refused.headers.get("location")).toMatch(/error=signup_disabled/);
    expect(refused.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(false);
    // Nor does it join the account of the same email: only a link does.
    const sameEmail = await signedIn(hopper.email);
    github.set("code-8", { ...hopper, token: "gho_eight" });
    const unlinked = await viaGitHub("code-8", undefined, "sign-in/social");
    expect(unlinked.headers.get("location")).toMatch(/error=account_not_linked/);
    // Linked, the same GitHub account signs them in.
    github.set("code-9", { ...hopper, token: "gho_nine" });
    await viaGitHub("code-9", sameEmail.cookie);
    github.set("code-10", { ...hopper, token: "gho_ten" });
    const back = await viaGitHub("code-10", undefined, "sign-in/social");
    expect(back.headers.get("location")).toBe("/account");
    const session = back.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="))!;
    expect(await half.verify(request("/", { cookie: session.split(";")[0] }))).toEqual({
      subject: (await half.verify(request("/", { cookie: sameEmail.cookie })))!.subject,
      email: hopper.email,
      github: "hopper",
    });
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
    const plain = await betterAuthLogin(context);
    try {
      expect(plain.methods).toEqual(["password"]);
      const { cookie } = await signUp(plain);
      const started = await plain.handle(
        request("/auth/better-auth/link-social", { cookie, body: { provider: "github", callbackURL: "/" } }),
      );
      expect(started?.status).toBe(404);
    } finally {
      await plain.close?.();
    }
  });
});
