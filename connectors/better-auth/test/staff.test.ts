import { hkdfSync, randomUUID } from "node:crypto";
import {
  CLIENT_IP_HEADER,
  type LoginContext,
  type LoginHalf,
  type LoginIdentity,
  type SignInMethod,
} from "@sanoma-ai/workflows";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuthStaffLogin } from "../src/staff.ts";

// The staff login: codes only to declared emails, no row for anyone else, invites as one-use
// magic links, each sign-in told to the app, changes only from the page's own origin.

const databaseUrl = testDatabaseUrl("better_auth_staff");
const key = Buffer.from(hkdfSync("sha256", process.env.SANOMA_SIGNING_KEY!, "", "login staff", 32)).toString("hex");
const HOST = "company.example";
const DECLARED = "alice@example.com";

const codes = new Map<string, string>();
const signIns: [SignInMethod, LoginIdentity][] = [];
const context: LoginContext = {
  databaseUrl,
  key,
  secrets: async () => new Map(),
  origins: [],
  sendCode: async (email, code) => void codes.set(email, code),
  staff: {
    admits: ({ email }) => email?.toLowerCase() === DECLARED,
    social: {},
    record: async (method, identity) => void signIns.push([method, identity]),
  },
};

/** A request from the app's page on its host: Origin the page's, an address of its own. */
function request(path: string, init: { body?: unknown; cookie?: string; origin?: string } = {}): Request {
  const headers = new Headers({
    host: HOST,
    origin: init.origin ?? `https://${HOST}`,
    "x-forwarded-proto": "https",
    [CLIENT_IP_HEADER]: `10.1.0.${nextIp++}`,
  });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://${HOST}${path}`, {
    method: init.body === undefined && !path.endsWith("sign-out") ? "GET" : "POST",
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}
let nextIp = 1;

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((c) => c.includes("session_token="))
    ?.split(";")[0] ?? "";

/** A JSON answer, as GitHub gives one. */
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The GitHub account `id`'s stored access token, by row. */
async function tokensOf(id: number): Promise<{ access_token: string | null }[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sql = `SELECT "accessToken" AS access_token FROM better_auth_staff.account WHERE "providerId" = 'github' AND "accountId" = $1`;
    return (await client.query(sql, [String(id)])).rows as { access_token: string | null }[];
  } finally {
    await client.end();
  }
}

async function rows(table: string): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(`SELECT 1 FROM better_auth_staff."${table}"`)).rowCount ?? 0;
  } finally {
    await client.end();
  }
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
  await client.query("DROP SCHEMA IF EXISTS better_auth_staff CASCADE");
  await client.end();
});

describe("the staff login", () => {
  let half: LoginHalf;
  beforeAll(async () => {
    half = await betterAuthStaffLogin(context);
  });
  afterAll(() => half.close?.());
  beforeEach(() => {
    codes.clear();
    signIns.length = 0;
  });

  it("offers a code and invites, and GitHub only with the company's client", async () => {
    expect(half.methods).toEqual(["code", "invite"]);
    const github = await betterAuthStaffLogin({
      ...context,
      sendCode: undefined,
      staff: { ...context.staff!, social: { github: { clientId: "id", clientSecret: "secret" } } },
    });
    try {
      expect(github.methods).toEqual(["github", "invite"]);
      const sent = await github.handle(
        request("/auth/better-auth/email-otp/send-verification-otp", { body: { email: DECLARED, type: "sign-in" } }),
      );
      expect(sent?.status).toBe(404);
    } finally {
      await github.close?.();
    }
  });

  it("sends a code to a declared email only, answering an undeclared one the same and storing nothing", async () => {
    const before = await rows("verification");
    const stranger = (await half.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", {
        body: { email: "mallory@example.com", type: "sign-in" },
      }),
    ))!;
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual({ success: true });
    expect(codes.size).toBe(0);
    expect(await rows("verification")).toBe(before);

    const declared = (await half.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", { body: { email: DECLARED, type: "sign-in" } }),
    ))!;
    expect(await declared.json()).toEqual({ success: true });
    const code = codes.get(DECLARED)!;
    expect(code).toMatch(/^\d{6}$/);

    const signIn = (await half.handle(
      request("/auth/better-auth/sign-in/email-otp", { body: { email: DECLARED, otp: code } }),
    ))!;
    expect(signIn.status).toBe(200);
    const [setCookie] = signIn.headers.getSetCookie();
    expect(setCookie).toMatch(/^__Secure-sanoma\.session_token=.*; Secure/i);
    expect(await half.verify(request("/", { cookie: cookieOf(signIn) }))).toEqual({
      subject: expect.any(String),
      email: DECLARED,
    });
    expect(signIns).toEqual([["code", { email: DECLARED }]]);
  });

  it("signs a declared person in by an invite, once, and a new one replaces the last", async () => {
    const first = await half.invite!(DECLARED, request("/"));
    const token = await half.invite!(DECLARED, request("/"));
    expect(await half.invitation!(first)).toBeUndefined();
    const invitation = (await half.invitation!(token))!;
    expect(invitation.email).toBe(DECLARED);
    const landed = (await half.handle(request(invitation.path)))!;
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe(`https://${HOST}/`);
    expect(await half.verify(request("/", { cookie: cookieOf(landed) }))).toMatchObject({ email: DECLARED });
    expect(signIns).toEqual([["invite", { email: DECLARED }]]);
    expect(await half.invitation!(token)).toBeUndefined();
    const again = (await half.handle(request(invitation.path)))!;
    expect(again.headers.get("location")).toMatch(/error=INVALID_TOKEN/);
    // A redirect to another origin is refused before Better Auth sees it, which trusts any host here.
    for (const to of ["https://evil.example", "//evil.example"]) {
      const query = new URLSearchParams({ token: "x", errorCallbackURL: to });
      expect((await half.handle(request(`/auth/better-auth/magic-link/verify?${query}`)))?.status, to).toBe(400);
    }
  });

  it("makes no user for anyone the files do not declare, whatever the route", async () => {
    const users = await rows("user");
    const token = await half.invite!(`${randomUUID()}@example.com`, request("/"));
    const landed = (await half.handle(request((await half.invitation!(token))!.path)))!;
    expect(landed.headers.get("location")).toMatch(/error=/);
    expect(cookieOf(landed)).toBe("");
    expect(await rows("user")).toBe(users);
  });

  it("refuses a change from another origin, and a route a page has no business with", async () => {
    const forged = await half.handle(
      request("/auth/better-auth/email-otp/send-verification-otp", {
        body: { email: DECLARED, type: "sign-in" },
        origin: "https://evil.example",
      }),
    );
    expect(forged?.status).toBe(403);
    expect(codes.size).toBe(0);
    const send = await half.handle(request("/auth/better-auth/sign-in/magic-link", { body: { email: DECLARED } }));
    expect(send?.status).toBe(404);
    expect(await half.handle(request("/sites/www"))).toBeUndefined();
  });
});

describe("the staff login with GitHub", () => {
  const GITHUB_ONLY = "Ada-Lovelace";
  /** GitHub's side: each code it handed out, the token it is worth, and whose account that is. */
  const github = new Map<string, { token: string; id: number; login: string; email: string }>();
  let half: LoginHalf;
  beforeAll(async () => {
    const fetch = globalThis.fetch;
    // GitHub's three endpoints the sign-in takes: the token, the user and their emails; anything else as it is.
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
    half = await betterAuthStaffLogin({
      ...context,
      staff: {
        ...context.staff!,
        // Alice by her email, Ada by her GitHub login alone.
        admits: ({ email, github: login }) => email?.toLowerCase() === DECLARED || login === GITHUB_ONLY,
        social: { github: { clientId: "client-id", clientSecret: "client-secret" } },
      },
    });
  });
  afterAll(async () => {
    await half.close?.();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    signIns.length = 0;
  });

  /** Sends someone signed out to GitHub to sign in, and answers GitHub's redirect back with `code`, the account it stands for. */
  async function viaGitHub(code: string) {
    const started = (await half.handle(
      request("/auth/better-auth/sign-in/social", { body: { provider: "github", callbackURL: "/" } }),
    ))!;
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    const cookies = started.headers.getSetCookie().map((c) => c.split(";")[0]);
    const query = new URLSearchParams({ code, state: authorize.searchParams.get("state")! });
    return (await half.handle(request(`/auth/better-auth/callback/github?${query}`, { cookie: cookies.join("; ") })))!;
  }

  it("signs in a person declared by GitHub login alone, keeping the login and dropping the token", async () => {
    github.set("code-ada", { token: "gho_ada", id: 4101, login: GITHUB_ONLY, email: "ada@users.github.test" });
    const landed = await viaGitHub("code-ada");
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/");
    const identity = { email: "ada@users.github.test", github: GITHUB_ONLY };
    expect(await half.verify(request("/", { cookie: cookieOf(landed) }))).toEqual({
      subject: expect.any(String),
      ...identity,
    });
    expect(signIns).toEqual([["github", identity]]);
    expect(await tokensOf(4101)).toEqual([{ access_token: null }]);
  });

  it("makes no user for a GitHub account the files do not declare, and says so", async () => {
    const users = await rows("user");
    const accounts = await rows("account");
    github.set("code-mallory", {
      token: "gho_mallory",
      id: 4102,
      login: "mallory",
      email: "mallory@users.github.test",
    });
    const landed = await viaGitHub("code-mallory");
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toMatch(/error=not_declared/);
    expect(cookieOf(landed)).toBe("");
    expect(await rows("user")).toBe(users);
    expect(await rows("account")).toBe(accounts);
    expect(signIns).toEqual([]);
  });
});
