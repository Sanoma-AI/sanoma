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

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace", email: "ada@acme.test" });
export const bo = sanoma.person({ id: "bo", github: "bo-gh" });
export const cy = sanoma.person({ id: "cy" });
export const dee = sanoma.person({ id: "dee", name: "Dee Park", email: "dee@acme.test" });
export const admin = sanoma.group({ name: "admin", members: [ada] });
export const office = sanoma.group({ name: "office", members: [dee] });
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
    lastInvite: vi.fn<(...args: unknown[]) => Promise<{ by: string } | undefined>>(async () => ({ by: "ada" })),
    secrets: async () => new Map(),
  };
  let context: LoginContext;
  let login: LoginProvider;

  async function opened(
    methods: LoginMethod[] = ["code", "invite"],
    sender = true,
    stylesheet?: string,
  ): Promise<LoginProvider> {
    const provider = staffLogin(
      async (given) => {
        context = given;
        return fakeHalf(methods);
      },
      { github: { clientId: "id", clientSecret: "secret" } },
    );
    await provider.open!({
      resolved: {
        appName: "acme-plumbing",
        databaseUrl: "postgresql://x/y",
        root,
        ...(sender && { login: { sender: {}, from: "Acme <login@acme.test>" } }),
      },
      client,
      ...(stylesheet && { stylesheet }),
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
    expect(await admitted.resolveActor(signedIn)).toEqual({ id: "ada", groups: ["admin"] });
    expect(admitted.signOut).toBe("/auth/better-auth/sign-out");
  });

  it("shows the sign-in page for the company, or JSON to a server function", async () => {
    const page = (await login.handle!(request("/workflows")))!;
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain("<title>Sign in · Acme Plumbing</title>");
    expect(html).toContain(">AP</span>");
    expect(html).toContain("Sign in to Acme Plumbing");
    expect(html).toContain("We will email you a six-digit code. No password.");
    expect(html).toContain("Send a code");
    expect(html).toContain("If that address is declared, a code is on its way. It can take a minute.");
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain("3 wrong codes end the attempt. A code lasts five minutes.");
    expect(html).toContain("Sent again. The earlier code no longer works.");
    expect(html).toContain("Acme Plumbing · signed in people are declared in <code>resources/people.ts</code>");
    expect(html).not.toContain("Continue with GitHub");
    // The app's theme, as its document head sets it, and no stylesheet the dev server has not built.
    expect(html).toContain('localStorage.getItem("sanoma.theme")');
    expect(html).not.toContain('rel="stylesheet"');
    const fn = (await login.handle!(request("/_serverFn/abc", { method: "POST" })))!;
    expect(await fn.json()).toEqual({ error: "Sign in first" });

    const github = await opened(["code", "github", "invite"]);
    const both = await (await github.handle!(request("/")))!.text();
    expect(both).toContain("Continue with GitHub");
    expect(both).toContain('errorCallbackURL:"/auth/login"');
  });

  it("is the page at /auth/login, and sends someone signed in on to the app", async () => {
    const page = (await login.handle!(request("/auth/login")))!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in to Acme Plumbing");
    const signedIn = (await login.handle!(request("/auth/login", { cookie: "who=ada@acme.test" })))!;
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/");
  });

  /** The sign-in page's HTML when a GitHub sign-in came back with `?error=<error>`. */
  const errorPage = async (error: string) => await (await login.handle!(request(`/auth/login?error=${error}`)))!.text();

  it("says why a GitHub sign-in came back with ?error=", async () => {
    expect(await errorPage("email_not_found")).toContain(
      "GitHub did not share an email. The company&#39;s GitHub App needs the Email addresses permission; ask the person who runs this company.",
    );
    expect(await errorPage("account_already_linked_to_different_user")).toContain(
      "That GitHub account already signs in as someone else.",
    );
    expect(await errorPage("account_not_linked")).toContain("that email is not verified on both sides yet");
    expect(await errorPage("unable_to_link_account")).toContain("GitHub could not be connected to your account.");
    expect(await errorPage("<script>")).toContain("GitHub sign-in did not work. Try again, or use a code.");
  });

  it("links the kit's stylesheet, which loads signed out with its fonts, and nothing else does", async () => {
    const styled = await opened(["code", "invite"], true, "/assets/style-abc.css");
    const html = await (await styled.handle!(request("/auth/login")))!.text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/style-abc.css">');
    expect(await styled.handle!(request("/assets/style-abc.css"))).toBeUndefined();
    expect(await styled.handle!(request("/assets/ibm-plex-sans-latin-wght-normal-x.woff2"))).toBeUndefined();
    expect((await styled.handle!(request("/assets/main-abc.js")))?.status).toBe(401);
    expect((await login.handle!(request("/assets/style-abc.css")))?.status).toBe(401);
  });

  it("says to ask for an invite when email sign-in is not set up, naming no file", async () => {
    const invites = await opened(["invite"], false);
    const html = await (await invites.handle!(request("/")))!.text();
    expect(html).toContain("Email sign-in not set up");
    expect(html).toContain("Ask for an invite link");
    expect(html).toContain(
      "Sign-in by email is not set up for Acme Plumbing yet. Ask the person who runs it for an invite link; it signs you in once and expires in 24 hours.",
    );
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toMatch(/resources\/|sanoma\.config|Resend|SANOMA_/);

    const github = await opened(["github", "invite"], false);
    const both = await (await github.handle!(request("/")))!.text();
    expect(both).toContain("Ask for an invite link");
    expect(both).toContain("Continue with GitHub");
    expect(both).not.toMatch(/resources\/|sanoma\.config|Resend|SANOMA_/);
  });

  it("mints an invite for a declared colleague from someone signed in, on this page", async () => {
    const asked = (await login.handle!(
      request("/auth/invite", { cookie: "who=ada@acme.test", body: { email: "ada@acme.test" } }),
    ))!;
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ url: `${APP}/auth/invite/tok-ada@acme.test` });
    expect(client.recordInvite).toHaveBeenCalledWith("ada", { by: "ada", expiresAt: expect.any(Date) });

    // An invite signs its holder in as that person: someone not in admin gets none.
    const notAdmin = await login.handle!(
      request("/auth/invite", { cookie: "who=dee@acme.test", body: { email: "ada@acme.test" } }),
    );
    expect(notAdmin?.status).toBe(403);
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
    // A copy of a sealed request mints once.
    const once = sealInvite({ email: "ada@acme.test" });
    expect((await login.handle!(request("/auth/invite", { body: { request: once } })))?.status).toBe(200);
    expect((await login.handle!(request("/auth/invite", { body: { request: once } })))?.status).toBe(403);
    const expired = sealInvite({ email: "ada@acme.test", exp: Date.now() - 1 });
    expect((await login.handle!(request("/auth/invite", { body: { request: expired } })))?.status).toBe(403);
    expect((await login.handle!(request("/auth/invite", { body: { nope: 1 } })))?.status).toBe(400);
  });

  it("lands an invite on a page that names who sent it and whom it signs in, and says when it is spent", async () => {
    const page = (await login.handle!(request("/auth/invite/tok-dee@acme.test")))!;
    expect(page.status).toBe(200);
    expect(client.lastInvite).toHaveBeenCalledWith("dee");
    const html = await page.text();
    expect(html).toContain("Ada invited you to Acme Plumbing");
    expect(html).toContain("Ada Lovelace declared you in <code>resources/people.ts</code> as Dee Park, in office.");
    expect(html).toContain(">AL</span>");
    expect(html).toContain(">DP</span>");
    expect(html).toContain("Continue as dee@acme.test");
    expect(html).toContain('href="/auth/better-auth/magic-link/verify?token=tok-dee@acme.test"');
    expect(html).toContain("This link works once and expires in 24 hours.");
    expect(html).toContain('Not Dee? <a href="/auth/login">Sign in with your own email</a>');

    // A sealed request's invite was sent by the runtime's agent `login`: nobody to name.
    client.lastInvite.mockResolvedValueOnce({ by: "login" });
    const sealed = await (await login.handle!(request("/auth/invite/tok-dee@acme.test")))!.text();
    expect(sealed).toContain("You were invited to Acme Plumbing");
    expect(sealed).toContain("You are declared in <code>resources/people.ts</code> as Dee Park, in office.");

    const spent = (await login.handle!(request("/auth/invite/spent")))!;
    expect(spent.status).toBe(410);
    const gone = await spent.text();
    expect(gone).toContain("This invite link has been used, replaced or has expired. Ask for a new one.");
    expect(gone).toContain("Acme Plumbing");
  });

  it("listens on any host", () => {
    expect(() => login.check("0.0.0.0")).not.toThrow();
  });
});
