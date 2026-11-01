import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoginContext, type LoginHalf, type LoginMethod, sealInvite } from "@sanoma-ai/workflows";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext, LoginProvider } from "../src/context.ts";
import { admitting } from "../src/login/admission.ts";
import { staffLogin } from "../src/login/staff.ts";
import { readPeople } from "@sanoma-ai/workflows/describe";

// The app's side of the staff login, over a login half of its own: what it gives the half (who
// is declared, the sender, the ledger), the sign-in page, an invite's landing page and
// `POST /auth/invite`. Better Auth itself is `connectors/better-auth/test/staff.test.ts`'s.

const APP = "https://acme.example";
const root = mkdtempSync(join(tmpdir(), "sanoma-staff-"));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", email: "ada@acme.test" });
export const bo = sanoma.person({ id: "bo", github: "bo-gh" });
export const cy = sanoma.person({ id: "cy" });
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A login half that takes the cookie `who=<email>` as signed in, and mints invites `tok-<email>`. */
function fakeHalf(methods: LoginMethod[]): LoginHalf {
  return {
    async verify(request) {
      const email = /who=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      return email ? { subject: email, email } : null;
    },
    async handle(request) {
      return new URL(request.url).pathname.startsWith("/auth/better-auth/") ? new Response("half") : undefined;
    },
    signOut: "/auth/better-auth/sign-out",
    methods,
    invite: async (email) => `tok-${email}`,
    invitation: async (token) =>
      token.startsWith("tok-")
        ? { email: token.slice(4), path: `/auth/better-auth/magic-link/verify?token=${token}` }
        : undefined,
  };
}

const request = (path: string, init: { cookie?: string; method?: string; body?: unknown; origin?: string } = {}) =>
  new Request(new URL(path, APP), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      host: "acme.example",
      "x-forwarded-proto": "https",
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.body !== undefined && { "content-type": "application/json", origin: init.origin ?? APP }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });

describe("staffLogin", () => {
  const client = {
    start: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "run-1"),
    recordSignIn: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    recordInvite: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    secrets: async () => new Map(),
  };
  let context: LoginContext;
  let login: LoginProvider;

  async function opened(methods: LoginMethod[] = ["code", "invite"], sender = true): Promise<LoginProvider> {
    const provider = staffLogin(
      async (given) => {
        context = given;
        return fakeHalf(methods);
      },
      { github: { clientId: "id", clientSecret: "secret" } },
    );
    await provider.open!({
      resolved: { databaseUrl: "postgresql://x/y", root, ...(sender && { login: { sender: {} } }) },
      client,
    } as unknown as AppContext);
    return provider;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    login = await opened();
  });

  it("answers 503 until the app opens it", async () => {
    const early = staffLogin(async () => fakeHalf([]));
    expect((await early.handle!(request("/workflows")))?.status).toBe(503);
  });

  it("gives the half who is declared, the company's GitHub client and the sender", async () => {
    expect(context.staff!.admits({ email: "ADA@acme.test" })).toBe(true);
    expect(context.staff!.admits({ github: "bo-gh" })).toBe(true);
    expect(context.staff!.admits({ email: "mallory@acme.test" })).toBe(false);
    expect(context.staff!.social).toEqual({ github: { clientId: "id", clientSecret: "secret" } });
    expect(context.origins).toEqual([]);
    expect(context.key).toMatch(/^[0-9a-f]{64}$/);
    expect(login.signOut).toBe("/auth/better-auth/sign-out");

    await context.sendCode!("ada@acme.test", "123456");
    expect(client.start).toHaveBeenCalledWith(
      "login-code",
      { to: "ada@acme.test", code: expect.not.stringContaining("123456") },
      { startedBy: "login" },
    );
    await context.staff!.record("code", { email: "ada@acme.test" });
    expect(client.recordSignIn).toHaveBeenCalledWith("ada", "code");
  });

  it("gives no sender when the config names none", async () => {
    await opened(["invite"], false);
    expect(context.sendCode).toBeUndefined();
  });

  it("passes its half's routes through, and lets a signed-in request on", async () => {
    expect(await (await login.handle!(request("/auth/better-auth/get-session")))!.text()).toBe("half");
    const signedIn = request("/workflows", { cookie: "who=ada@acme.test" });
    expect(await login.handle!(signedIn)).toBeUndefined();
    expect(await login.resolveActor(signedIn)).toEqual({ email: "ada@acme.test" });
    const admitted = admitting(login, () => readPeople(root));
    expect(await admitted.resolveActor(signedIn)).toEqual({ id: "ada", groups: [] });
    expect(admitted.signOut).toBe("/auth/better-auth/sign-out");
  });

  it("shows the sign-in page, or JSON to a server function", async () => {
    const page = (await login.handle!(request("/workflows")))!;
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain("Send a code");
    expect(html).not.toContain("Sign in with GitHub");
    const fn = (await login.handle!(request("/_serverFn/abc", { method: "POST" })))!;
    expect(await fn.json()).toEqual({ error: "Sign in first" });

    const github = await opened(["github", "invite"]);
    expect(await (await github.handle!(request("/")))!.text()).toContain("Sign in with GitHub");
  });

  it("says to ask for an invite when no method but invites is on, naming no file", async () => {
    const invites = await opened(["invite"], false);
    const html = await (await invites.handle!(request("/")))!.text();
    expect(html).toContain("Ask the person who runs this company for an invite link.");
    expect(html).not.toMatch(/resources\/|sanoma\.config|Resend|SANOMA_/);
  });

  it("mints an invite for a declared colleague from someone signed in, on this page", async () => {
    const asked = (await login.handle!(
      request("/auth/invite", { cookie: "who=ada@acme.test", body: { email: "ada@acme.test" } }),
    ))!;
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ url: `${APP}/auth/invite/tok-ada@acme.test` });
    expect(client.recordInvite).toHaveBeenCalledWith("ada", { by: "ada", expiresAt: expect.any(Date) });

    const stranger = await login.handle!(
      request("/auth/invite", { cookie: "who=ada@acme.test", body: { email: "mallory@acme.test" } }),
    );
    expect(stranger?.status).toBe(403);
    const nobody = await login.handle!(request("/auth/invite", { body: { email: "ada@acme.test" } }));
    expect(nobody?.status).toBe(401);
    const forged = await login.handle!(
      request("/auth/invite", {
        cookie: "who=ada@acme.test",
        body: { email: "ada@acme.test" },
        origin: "https://evil.example",
      }),
    );
    expect(forged?.status).toBe(403);
  });

  it("mints one for a sealed request, as the login agent, and refuses one it did not seal", async () => {
    const asked = (await login.handle!(
      request("/auth/invite", { body: { request: sealInvite({ email: "ada@acme.test" }) } }),
    ))!;
    expect(await asked.json()).toEqual({ url: `${APP}/auth/invite/tok-ada@acme.test` });
    expect(client.recordInvite).toHaveBeenCalledWith("ada", { by: "login", expiresAt: expect.any(Date) });
    const expired = sealInvite({ email: "ada@acme.test", exp: Date.now() - 1 });
    expect((await login.handle!(request("/auth/invite", { body: { request: expired } })))?.status).toBe(403);
    expect((await login.handle!(request("/auth/invite", { body: { nope: 1 } })))?.status).toBe(400);
  });

  it("lands an invite on a page that names whom it signs in, and says when it is spent", async () => {
    const page = (await login.handle!(request("/auth/invite/tok-ada@acme.test")))!;
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Continue as ada@acme.test");
    expect(html).toContain('href="/auth/better-auth/magic-link/verify?token=tok-ada@acme.test"');
    expect((await login.handle!(request("/auth/invite/spent")))?.status).toBe(410);
  });

  it("listens on any host", () => {
    expect(() => login.check("0.0.0.0")).not.toThrow();
  });
});
