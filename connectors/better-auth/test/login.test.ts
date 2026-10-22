import { randomBytes, randomUUID } from "node:crypto";
import { CLIENT_IP_HEADER, type LoginContext, type LoginHalf } from "@sanoma-ai/workflows";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuthLogin } from "../src/login.ts";

const databaseUrl = testDatabaseUrl("better_auth");
const secret = randomBytes(32).toString("base64");
const SITE = "http://account.localhost:5173";
const context: LoginContext = {
  databaseUrl,
  secrets: async () => new Map([["BETTER_AUTH_SECRET", secret]]),
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

  it("refuses a secret under 32 characters, and an origin that is more than a scheme and a host", async () => {
    await expect(
      betterAuthLogin({ ...context, secrets: async () => new Map([["BETTER_AUTH_SECRET", "short"]]) }),
    ).rejects.toThrow(/32 characters or more/);
    await expect(betterAuthLogin({ ...context, secrets: async () => new Map() })).rejects.toThrow(/BETTER_AUTH_SECRET/);
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
