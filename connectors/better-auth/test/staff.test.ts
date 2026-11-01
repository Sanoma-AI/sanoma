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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
