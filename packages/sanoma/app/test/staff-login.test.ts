import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAddress,
  agentAddressAt,
  type LoginContext,
  NO_AGENT_ADDRESS,
  type LoginHalf,
  type LoginMethod,
  sealInvite,
} from "sanoma/workflows";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext, LoginProvider } from "../src/context.ts";
import type { AppSnapshot } from "../src/snapshot.ts";
import { admitting } from "../src/login/admission.ts";
import { staffLogin } from "../src/login/staff.ts";
import { readPeople } from "sanoma/workflows/describe";
import { CLAUDE_CODE } from "./staff-oauth-helpers.ts";

// The app's side of the staff login, over a login half of its own: what it gives the half (who
// is declared, the sender, the ledger), the sign-in page, an invite's landing page and
// `POST /auth/invite`. Better Auth itself is `packages/sanoma/better-auth/test/staff.test.ts`'s.

const APP = "https://acme.example";
/** The instance's agent address: the app's own origin's. */
const ADDRESS = agentAddressAt(APP);
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
export const claudeCode = sanoma.agent({ id: "claude-code", client: "${CLAUDE_CODE}" });
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A login half that takes the cookie `who=<email>` as signed in, mints invites `tok-<email>`, and
 * takes the bearer `at.<email>.<client>` as a token issued for that email to that client.
 */
function fakeHalf(methods: LoginMethod[]): LoginHalf {
  return {
    async verify(request) {
      const email = /who=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      return email ? { subject: email, email } : null;
    },
    async bearer(request) {
      const [, email, client] =
        /^Bearer at\.([^ ]+?)\.(https:\S+)$/.exec(request.headers.get("authorization") ?? "") ?? [];
      return email && client ? { subject: email, email, client } : null;
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

const request = (
  path: string,
  init: { cookie?: string; method?: string; body?: unknown; origin?: string; bearer?: string; host?: string } = {},
) =>
  new Request(new URL(path, init.host ? `https://${init.host}` : APP), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      host: init.host ?? "acme.example",
      "x-forwarded-proto": "https",
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.bearer && { authorization: `Bearer ${init.bearer}` }),
      ...(init.body !== undefined && { "content-type": "application/json", origin: init.origin ?? APP }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });

/** A JSON-RPC request to `/mcp`, as a client posts one: no Origin, maybe a bearer, on the app's host unless `host` says another. */
const mcp = (bearer?: string, host?: string) =>
  request("/mcp", { method: "POST", ...(bearer && { bearer }), ...(host && { host }) });

/** The consent page for `clientId`'s sign-in, asked by Ada, signed in. */
const consentFor = (provider: LoginProvider, clientId: string) =>
  provider.handle!(
    request(`/auth/consent?${new URLSearchParams({ client_id: clientId, sig: "x" })}`, { cookie: "who=ada@acme.test" }),
  );
/** The half's authorize for `clientId`, as a browser asks it. */
const authorizeFor = (provider: LoginProvider, clientId: string) =>
  provider.handle!(request(`/auth/better-auth/oauth2/authorize?${new URLSearchParams({ client_id: clientId })}`));

describe("staffLogin", () => {
  /** The runtime's table of spent invite-request nonces, as the client keeps it. */
  const nonces = new Set<string>();
  const client = {
    start: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "run-1"),
    recordSignIn: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    recordInvite: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    lastInvite: vi.fn<(...args: unknown[]) => Promise<{ by: string } | undefined>>(async () => ({ by: "ada" })),
    spendInviteRequest: vi.fn<(nonce: string) => Promise<boolean>>(async (nonce) => {
      if (nonces.has(nonce)) return false;
      nonces.add(nonce);
      return true;
    }),
    secrets: async () => new Map(),
    pool: vi.fn<() => Promise<unknown>>(async () => pool),
  };
  /** What stands for the client's pool: the half is given it, and nothing here reads it. */
  const pool = { the: "pool" };
  let context: LoginContext;
  let login: LoginProvider;

  async function opened(
    options: {
      methods?: LoginMethod[];
      /** Whether the config names a sender for the email code. */
      sender?: boolean;
      stylesheet?: string;
      /** The company as its files say at a request (`open`'s `current`): the one snapshot unless given. */
      current?: (snapshot: AppSnapshot) => AppSnapshot | Promise<AppSnapshot>;
      /** The instance's agent address: `ADDRESS` unless given, and none when given as undefined. */
      address?: AgentAddress | undefined;
    } = {},
  ): Promise<LoginProvider> {
    const { methods = ["code", "invite"], sender = true, stylesheet, current } = options;
    const address = "address" in options ? options.address : ADDRESS;
    const provider = staffLogin(
      async (given) => {
        context = given;
        return fakeHalf(methods);
      },
      { github: { clientId: "id", clientSecret: "secret" } },
      address,
    );
    const snapshot = { people: readPeople(root) } as AppSnapshot;
    await provider.open!(
      {
        resolved: {
          appName: "acme-plumbing",
          name: "Acme Plumbing",
          root,
          ...(sender && { login: { sender: {}, from: "Acme <login@acme.test>" } }),
        },
        client,
        snapshot,
        ...(stylesheet && { stylesheet }),
      } as unknown as AppContext,
      () => (current ? current(snapshot) : snapshot),
    );
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
    expect(await context.staff!.admits({ email: "ADA@acme.test" })).toBe(true);
    expect(await context.staff!.admits({ github: "bo-gh" })).toBe(true);
    expect(await context.staff!.admits({ email: "mallory@acme.test" })).toBe(false);
    expect(context.staff!.social).toEqual({ github: { clientId: "id", clientSecret: "secret" } });
    expect(context.origins).toEqual([]);
    expect(context.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await context.database()).toBe(pool);
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
    await opened({ methods: ["invite"], sender: false });
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

    const github = await opened({ methods: ["code", "github", "invite"] });
    const both = await (await github.handle!(request("/")))!.text();
    expect(both).toContain("Continue with GitHub");
    expect(both).toContain('errorCallbackURL:"/auth/login"');
  });

  it("is the page at /auth/login, and sends someone signed in and declared on to the app", async () => {
    const page = (await login.handle!(request("/auth/login")))!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in to Acme Plumbing");
    const signedIn = (await login.handle!(request("/auth/login", { cookie: "who=ada@acme.test" })))!;
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/");
    // A session of someone no longer declared is not sent on to a 403: the page again, to sign in as someone else.
    const removed = (await login.handle!(request("/auth/login", { cookie: "who=mallory@acme.test" })))!;
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain("Sign in to Acme Plumbing");
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
    expect(await errorPage("not_declared")).toContain(
      "This company&#39;s files declare nobody with that GitHub account.",
    );
    expect(await errorPage("<script>")).toContain("GitHub sign-in did not work. Try again, or use a code.");
    // A code an object inherits (`toString`) is a code the page does not know.
    expect(await errorPage("toString")).toContain("GitHub sign-in did not work. Try again, or use a code.");
    expect(await errorPage("constructor")).toContain("GitHub sign-in did not work. Try again, or use a code.");
  });

  it("links the kit's stylesheet, which loads signed out with its fonts, and nothing else does", async () => {
    const styled = await opened({ stylesheet: "/assets/style-abc.css" });
    const html = await (await styled.handle!(request("/auth/login")))!.text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/style-abc.css">');
    expect(await styled.handle!(request("/assets/style-abc.css"))).toBeUndefined();
    expect(await styled.handle!(request("/assets/ibm-plex-sans-latin-wght-normal-x.woff2"))).toBeUndefined();
    expect((await styled.handle!(request("/assets/main-abc.js")))?.status).toBe(401);
    expect((await login.handle!(request("/assets/style-abc.css")))?.status).toBe(401);
  });

  it("says to ask for an invite when email sign-in is not set up, naming no file", async () => {
    const invites = await opened({ methods: ["invite"], sender: false });
    const html = await (await invites.handle!(request("/")))!.text();
    expect(html).toContain("Email sign-in not set up");
    expect(html).toContain("Ask for an invite link");
    expect(html).toContain(
      "Sign-in by email is not set up for Acme Plumbing yet. Ask the person who runs it for an invite link; it signs you in once and expires in 24 hours.",
    );
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toMatch(/resources\/|sanoma\.config|Resend|SANOMA_/);

    const github = await opened({ methods: ["github", "invite"], sender: false });
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

  it("lands an invite naming nobody when the people file does not load, or who sent it cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    client.lastInvite.mockRejectedValueOnce(new Error("ledger down"));
    const unsent = await (await login.handle!(request("/auth/invite/tok-dee@acme.test")))!.text();
    expect(unsent).toContain("You were invited to Acme Plumbing");
    expect(unsent).toContain("as Dee Park, in office.");

    const broken = mkdtempSync(join(tmpdir(), "sanoma-staff-broken-"));
    mkdirSync(join(broken, "resources"));
    writeFileSync(join(broken, "resources", "people.ts"), "export const = ;\n");
    try {
      const provider = staffLogin(async () => fakeHalf(["code", "invite"]));
      const snapshot = { people: readPeople(broken) } as AppSnapshot;
      await provider.open!(
        {
          resolved: { appName: "acme-plumbing", name: "Acme Plumbing", root: broken },
          client,
          snapshot,
        } as unknown as AppContext,
        () => snapshot,
      );
      const page = (await provider.handle!(request("/auth/invite/tok-dee@acme.test")))!;
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("You were invited to Acme Plumbing");
      expect(html).toContain("Continue as dee@acme.test");
    } finally {
      rmSync(broken, { recursive: true, force: true });
      vi.mocked(console.error).mockRestore();
    }
  });

  it("admits nobody, and fails no sign-in, while the people cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unread = await opened({
        current: async () => {
          throw new Error("resources/people.ts: Unexpected token");
        },
      });
      const { staff } = context;
      // What the half is told: nobody is declared, and a sign-in it made is not the app's to fail.
      expect(await staff!.admits({ email: "ada@acme.test" })).toBe(false);
      await expect(staff!.record("code", { email: "ada@acme.test" })).resolves.toBeUndefined();
      expect(client.recordSignIn).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("resources/people.ts: Unexpected token"));
      // The login's own pages: someone signed in is shown the sign-in page, as nobody admitted is.
      const ada = { cookie: "who=ada@acme.test" };
      expect((await unread.handle!(request("/auth/login", ada)))?.status).toBe(200);
      expect((await unread.handle!(request("/auth/consent?client_id=x&sig=y", ada)))?.status).toBe(401);
      const asked = await unread.handle!(request("/auth/invite", { ...ada, body: { email: "dee@acme.test" } }));
      expect(asked?.status).toBe(401);
      // Any other page is let on to the app's admission, which says the people could not be checked.
      const page = request("/workflows", ada);
      expect(await unread.handle!(page)).toBeUndefined();
      const refused = (await admitting(unread, async () => {
        throw new Error("resources/people.ts: Unexpected token");
      }).handle!(page))!;
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("Who is asking could not be checked");
    } finally {
      logged.mockRestore();
    }
  });

  it("reads the people once for a request, however often the request asks, and again for the next", async () => {
    let reads = 0;
    /** A half whose authorize asks what Better Auth's asks of the app: the client's agent four times over, and who is admitted. */
    const asking: LoginHalf = {
      ...fakeHalf(["code", "invite"]),
      async handle(asked) {
        if (new URL(asked.url).pathname !== "/auth/better-auth/oauth2/authorize") return undefined;
        const { admits, oauth } = context.staff!;
        const agents = [];
        for (let times = 0; times < 4; times++) agents.push(await oauth!.agentOf(CLAUDE_CODE));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({ agents, admitted: await admits({ email: "ada@acme.test" }) });
      },
      async bearer(asked) {
        const agent = await context.staff!.oauth!.agentOf(CLAUDE_CODE);
        return agent && asked.headers.has("authorization")
          ? { subject: "ada", email: "ada@acme.test", client: CLAUDE_CODE }
          : null;
      },
    };
    const provider = staffLogin(
      async (given) => {
        context = given;
        return asking;
      },
      {},
      ADDRESS,
    );
    const snapshot = { people: readPeople(root) } as AppSnapshot;
    const app = { resolved: { appName: "acme-plumbing", name: "Acme Plumbing", root }, client, snapshot };
    await provider.open!(app as unknown as AppContext, () => {
      reads++;
      return snapshot;
    });
    const authorize = await provider.handle!(request("/auth/better-auth/oauth2/authorize"));
    expect(await authorize!.json()).toEqual({ agents: Array(4).fill("claude-code"), admitted: true });
    expect(reads).toBe(1);
    // The login's own pages: who is admitted, then the consent page's client and person.
    reads = 0;
    const query = new URLSearchParams({ client_id: CLAUDE_CODE, sig: "x" });
    const consent = await provider.handle!(request(`/auth/consent?${query}`, { cookie: "who=ada@acme.test" }));
    expect(consent?.status).toBe(200);
    expect(reads).toBe(1);
    // A bearer at /mcp: the half's check, then who the app's own resolve asks, the one request's.
    reads = 0;
    const call = mcp(`at.ada@acme.test.${CLAUDE_CODE}`);
    expect(await provider.handle!(call)).toBeUndefined();
    expect(await provider.resolveActor(call)).toMatchObject({ client: CLAUDE_CODE });
    expect(reads).toBe(1);
    // Two requests at once read once each: neither is answered with what the other read.
    reads = 0;
    await Promise.all([
      provider.handle!(request("/auth/better-auth/oauth2/authorize")),
      provider.handle!(request("/auth/better-auth/oauth2/authorize")),
    ]);
    expect(reads).toBe(2);
  });

  it("goes back to the page asked for on this host once signed in, never to another a path names", async () => {
    const html = await (await login.handle!(request("/workflows")))!.text();
    const line = /const here=[^\n]*?const back=[^;]+;/.exec(html)?.[0];
    expect(line).toBeDefined();
    const back = (pathname: string, search = "") =>
      new Function("location", `${line} return back;`)({ pathname, search }) as string;
    expect(back("/workflows", "?tab=runs")).toBe("/workflows?tab=runs");
    expect(back("/auth/login", "?error=x")).toBe("/");
    expect(back("//evil.example/login")).toBe("/evil.example/login");
    expect(back("///evil.example")).toBe("/evil.example");
  });

  /** The half's signed request, as authorize puts it in the sign-in page's address: each name it signed, then the signature. */
  const SIGNED = "client_id=x&state=a*b&exp=1&ba_param=ba_param&ba_param=client_id&ba_param=exp&ba_param=state&sig=y";
  const EXPIRED = "This sign-in from the agent has expired. Start it again from the agent.";

  /**
   * The sign-in page at `/auth/login?<search>` as a browser runs it: its script over stand-ins
   * for the page's elements, with `answers` the login's answer to each POST, by its path.
   */
  async function signInPage(
    search: string,
    answers: Record<string, () => { status: number; body: unknown }>,
    cookie?: string,
  ) {
    login = await opened({ methods: ["code", "github", "invite"] });
    const page = (await login.handle!(request(`/auth/login?${search}`, { ...(cookie && { cookie }) })))!;
    expect(page.status).toBe(200);
    const html = await page.text();
    // The page's last script: the one before it sets the theme.
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    type Handler = (event: unknown) => Promise<void>;
    const elements = new Map<string, { textContent: string; hidden: boolean; on: Record<string, Handler> }>();
    const document = {
      getElementById(id: string) {
        if (!html.includes(`id="${id}"`)) return null;
        if (!elements.has(id)) {
          const on: Record<string, Handler> = {};
          elements.set(id, {
            textContent: "",
            hidden: false,
            on,
            addEventListener: (type: string, handler: Handler) => void (on[type] = handler),
            reset: () => undefined,
            querySelector: () => ({ focus: () => undefined }),
          } as never);
        }
        return elements.get(id);
      },
    };
    const location = {
      pathname: "/auth/login",
      search: `?${search}`,
      href: "",
      assign: vi.fn<(to: string) => void>(),
    };
    const posted: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = async (path: string, init: { body: string }) => {
      posted.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
      const { status, body } = answers[path]?.() ?? { status: 200, body: { success: true } };
      return Response.json(body, { status });
    };
    /** A form's fields, as the stand-in for the form (an event's target) holds them. */
    class FormData {
      readonly fields: Record<string, string>;
      constructor(fields: Record<string, string>) {
        this.fields = fields;
      }
      get = (name: string) => this.fields[name];
    }
    new Function("document", "location", "fetch", "FormData", script)(document, location, fetch, FormData);
    const fire = (id: string, type: string, fields: Record<string, string> = {}) =>
      elements.get(id)!.on[type]!({ preventDefault: () => undefined, target: fields });
    return {
      location,
      posted,
      message: () => elements.get("message")!.textContent,
      email: (email: string) => fire("email", "submit", { email }),
      code: (otp: string) => fire("code", "submit", { otp }),
      github: () => fire("github", "click"),
    };
  }

  describe("the agent surface's sign-in", () => {
    const METADATA = `${APP}/.well-known/oauth-protected-resource/mcp`;

    it("gives the half its OAuth: the configured address, and the agent each client stands for, as the files say", async () => {
      expect(ADDRESS).toEqual({ issuer: `${APP}/auth/better-auth`, resource: `${APP}/mcp` });
      expect(context.staff!.oauth!.address).toEqual(ADDRESS);
      expect(await context.staff!.oauth!.agentOf(CLAUDE_CODE)).toBe("claude-code");
      expect(await context.staff!.oauth!.agentOf("https://elsewhere.example/client.json")).toBeUndefined();
    });

    it("answers /mcp without a token or a session the 401 that starts a client's sign-in", async () => {
      const refused = (await login.handle!(mcp()))!;
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}"`);
      // Anywhere else, the sign-in page's answer as before, with no challenge.
      const fn = (await login.handle!(request("/_serverFn/abc", { method: "POST" })))!;
      expect([fn.status, fn.headers.get("www-authenticate")]).toEqual([401, null]);
    });

    it("names the configured address's metadata in the 401, whatever host the request came in on", async () => {
      // The app reached by another name (an address, a proxy's own): the one address tokens are for.
      for (const host of ["10.0.0.7:3000", "made-up.example"]) {
        const refused = (await login.handle!(mcp(undefined, host)))!;
        expect([refused.status, refused.headers.get("www-authenticate")], host).toEqual([
          401,
          `Bearer resource_metadata="${METADATA}"`,
        ]);
        const bad = (await login.handle!(mcp("at.nothing", host)))!;
        expect(bad.headers.get("www-authenticate"), host).toMatch(
          new RegExp(`^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="${METADATA}"$`),
        );
        expect(bad.headers.get("www-authenticate"), host).not.toContain(host);
        // A bearer the half takes is taken there too: the half checks it against the address, not the Host.
        expect(await login.handle!(mcp(`at.ada@acme.test.${CLAUDE_CODE}`, host)), host).toBeUndefined();
      }
    });

    it("gives the half no OAuth without an agent address, and /mcp's 401 says what to set", async () => {
      const plain = await opened({ address: undefined });
      expect(context.staff!.oauth).toBeUndefined();
      // No client can sign in: no challenge to follow, with or without a token, and the setting named.
      for (const asked of [mcp(), mcp("at.nothing"), request("/mcp/", { method: "POST" })]) {
        const refused = (await plain.handle!(asked))!;
        expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([401, null]);
        expect(refused.headers.get("cache-control")).toBe("no-store");
        expect(((await refused.json()) as { error: string }).error).toBe(NO_AGENT_ADDRESS);
      }
      // A half with no OAuth has no `bearer`: a token is nobody, whatever it says.
      const { bearer: _bearer, ...halfWithout } = fakeHalf(["code", "invite"]);
      const without = staffLogin(async () => halfWithout);
      await without.open!(
        { resolved: { appName: "acme-plumbing", name: "Acme Plumbing", root }, client } as unknown as AppContext,
        () => ({ people: readPeople(root) }) as AppSnapshot,
      );
      const token = mcp(`at.ada@acme.test.${CLAUDE_CODE}`);
      expect((await without.handle!(token))?.status).toBe(401);
      expect(await without.resolveActor(token)).toBeUndefined();
      // Someone signed in still reaches /mcp as themselves, as before, and every page signs in as it did.
      const signedIn = request("/mcp", { method: "POST", cookie: "who=ada@acme.test" });
      expect(await plain.handle!(signedIn)).toBeUndefined();
      expect(await plain.resolveActor(signedIn)).toEqual({ email: "ada@acme.test" });
      expect((await plain.handle!(request("/workflows")))?.status).toBe(401);
      expect((await plain.handle!(request("/.well-known/oauth-protected-resource/mcp")))?.status).toBe(404);
    });

    it("answers a well-known path the half does not 404, never the sign-in page", async () => {
      for (const path of ["/.well-known/x", "/.well-known/openid-configuration"]) {
        const lost = (await login.handle!(request(path)))!;
        expect([lost.status, lost.headers.get("content-type")], path).toEqual([404, "text/plain;charset=UTF-8"]);
      }
    });

    it("takes a bearer at /mcp, as the declared agent for the person it was issued for", async () => {
      const asked = mcp(`at.ada@acme.test.${CLAUDE_CODE}`);
      expect(await login.handle!(asked)).toBeUndefined();
      expect(await login.resolveActor(asked)).toEqual({ email: "ada@acme.test", client: CLAUDE_CODE });
      const admitted = admitting(login, () => readPeople(root));
      expect(await admitted.handle!(asked)).toBeUndefined();
      expect(await admitted.resolveActor(asked)).toEqual({ id: "claude-code", groups: ["agents"], onBehalfOf: "ada" });
      // Its bearer is what says who, never a cookie beside it.
      const both = request("/mcp", {
        method: "POST",
        bearer: `at.dee@acme.test.${CLAUDE_CODE}`,
        cookie: "who=ada@acme.test",
      });
      expect(await admitted.resolveActor(both)).toMatchObject({ id: "claude-code", onBehalfOf: "dee" });
    });

    it("answers a bearer it does not take 401 invalid_token, and takes none but at /mcp", async () => {
      const refused = (await login.handle!(mcp("at.nothing")))!;
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toMatch(
        new RegExp(`^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="${METADATA}"$`),
      );
      // A good bearer elsewhere is no sign-in: the page's 401.
      const elsewhere = (await login.handle!(
        request("/_serverFn/abc", { method: "POST", bearer: `at.ada@acme.test.${CLAUDE_CODE}` }),
      ))!;
      expect(elsewhere.status).toBe(401);
    });

    it("refuses a token for a client no agent declares, or for someone undeclared, 403 saying what to declare", async () => {
      const admitted = admitting(login, () => readPeople(root));
      const stranger = "https://elsewhere.example/client.json";
      const undeclared = (await admitted.handle!(mcp(`at.ada@acme.test.${stranger}`)))!;
      expect(undeclared.status).toBe(403);
      expect(await undeclared.json()).toEqual({
        code: "not_admitted",
        error: expect.stringContaining(`declare one, sanoma.agent({ id: "<its name>", client: "${stranger}" })`),
      });
      const mallory = (await admitted.handle!(mcp(`at.mallory@acme.test.${CLAUDE_CODE}`)))!;
      expect(mallory.status).toBe(403);
    });

    it("shows the consent page to someone signed in: the client, the agent it acts as, for whom", async () => {
      const query = new URLSearchParams({ client_id: CLAUDE_CODE, scope: "offline_access", sig: "x" });
      const page = (await login.handle!(request(`/auth/consent?${query}`, { cookie: "who=ada@acme.test" })))!;
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Let claude-code act for you?");
      expect(html).toContain(
        `${CLAUDE_CODE} asks to work in Acme Plumbing as the agent <strong>claude-code</strong>, for Ada Lovelace.`,
      );
      expect(html).toContain("/auth/better-auth/oauth2/consent");
      // Signed out, the sign-in page; a client no agent stands for, refused.
      expect((await login.handle!(request(`/auth/consent?${query}`)))?.status).toBe(401);
      const stranger = new URLSearchParams({ client_id: "https://elsewhere.example/client.json", sig: "x" });
      expect((await login.handle!(request(`/auth/consent?${stranger}`, { cookie: "who=ada@acme.test" })))?.status).toBe(
        403,
      );
    });

    describe("a built-in client, which no agent declares", () => {
      const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
      const PERSONS = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace", email: "ada@acme.test" });
`;
      /** The login over a company whose `resources/people.ts` is `PERSONS` and `rest`, with those people. */
      async function over(rest = "") {
        const other = mkdtempSync(join(tmpdir(), "sanoma-staff-built-in-"));
        mkdirSync(join(other, "resources"));
        writeFileSync(join(other, "resources", "people.ts"), PERSONS + rest);
        const people = readPeople(other);
        rmSync(other, { recursive: true, force: true });
        expect(people.problems).toEqual([]);
        return { people, provider: await opened({ current: (s) => ({ ...s, people }) }) };
      }
      it("is accepted as its built-in agent for the person, and the consent page says it is Sanoma's, not turned off", async () => {
        const { people, provider } = await over();
        expect(await context.staff!.oauth!.agentOf(CLAUDE_CODE)).toBe("claude-code");
        expect(await context.staff!.oauth!.agentOf(CLAUDE)).toBe("claude-ai");
        expect(await context.staff!.oauth!.agentOf("https://elsewhere.example/client.json")).toBeUndefined();
        // Authorize is the half's, as for a declared client.
        expect(await (await authorizeFor(provider, CLAUDE_CODE))!.text()).toBe("half");
        const page = (await consentFor(provider, CLAUDE_CODE))!;
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain("Let Claude Code act for you?");
        expect(html).toContain(
          `${CLAUDE_CODE} asks to work in Acme Plumbing as the agent <strong>claude-code</strong>, for Ada Lovelace.`,
        );
        expect(html).toContain(
          "Claude Code is built in to Sanoma: Acme Plumbing did not declare it, and has not turned it off.",
        );
        expect(html).not.toContain("declared this agent");
        expect(await (await consentFor(provider, CLAUDE))!.text()).toContain("Let Claude act for you?");
        // Its bearer at /mcp: the built-in agent, in agents, for the person it was issued for.
        const admitted = admitting(provider, () => people);
        const asked = mcp(`at.ada@acme.test.${CLAUDE_CODE}`);
        expect(await admitted.handle!(asked)).toBeUndefined();
        expect(await admitted.resolveActor(asked)).toEqual({
          id: "claude-code",
          groups: ["agents"],
          onBehalfOf: "ada",
        });
        // The consent page of an agent the company declared says so instead.
        const declared = await (await consentFor(login, CLAUDE_CODE))!.text();
        expect(declared).toContain("Acme Plumbing declared this agent in <code>resources/people.ts</code>.");
        expect(declared).not.toContain("built in to Sanoma");
      });

      it("is refused once the company turns it off, at authorize, consent and /mcp, saying it is off and never to declare it", async () => {
        const { people, provider } = await over(
          `export const noClaudeCode = sanoma.agent({ id: "claude-code", off: true });\n`,
        );
        expect(await context.staff!.oauth!.agentOf(CLAUDE_CODE)).toBeUndefined();
        // The other built-in is untouched.
        expect(await context.staff!.oauth!.agentOf(CLAUDE)).toBe("claude-ai");
        for (const refused of [await authorizeFor(provider, CLAUDE_CODE), await consentFor(provider, CLAUDE_CODE)]) {
          expect(refused!.status).toBe(403);
          expect(refused!.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
          const html = await refused!.text();
          expect(html).toContain("Claude Code is turned off here");
          expect(html).toContain(
            "Acme Plumbing turned off Claude Code, Sanoma's built-in agent <code>claude-code</code>",
          );
          expect(html).toContain(CLAUDE_CODE);
          expect(html).not.toMatch(/declare/i);
        }
        const admitted = admitting(provider, () => people);
        const token = (await admitted.handle!(mcp(`at.ada@acme.test.${CLAUDE_CODE}`)))!;
        expect(token.status).toBe(403);
        const said = (await token.json()) as { code: string; error: string };
        expect(said.code).toBe("not_admitted");
        expect(said.error).toContain("This company turned off Claude Code, Sanoma's built-in agent claude-code");
        expect(said.error).not.toContain("declare one");
        // A client that is not built in is still the half's to refuse, as before.
        expect(await (await authorizeFor(provider, "https://elsewhere.example/client.json"))!.text()).toBe("half");
      });

      it("is replaced by the company's own declaration of the client, and refused while its agent's id is another's", async () => {
        const ours = await over(
          `export const ours = sanoma.agent({ id: "our-claude", name: "Our Claude", client: "${CLAUDE_CODE}" });\n`,
        );
        expect(await context.staff!.oauth!.agentOf(CLAUDE_CODE)).toBe("our-claude");
        const html = await (await consentFor(ours.provider, CLAUDE_CODE))!.text();
        expect(html).toContain("Let Our Claude act for you?");
        expect(html).toContain("as the agent <strong>our-claude</strong>");
        expect(html).toContain("Acme Plumbing declared this agent");
        const admitted = admitting(ours.provider, () => ours.people);
        expect(await admitted.resolveActor(mcp(`at.ada@acme.test.${CLAUDE_CODE}`))).toEqual({
          id: "our-claude",
          groups: ["agents"],
          onBehalfOf: "ada",
        });
        // An agent of the company's with the built-in's id, for another client: the built-in does not act.
        const taken = await over(
          `export const claudeCode = sanoma.agent({ id: "claude-code", client: "claude-code" });\n`,
        );
        expect(await context.staff!.oauth!.agentOf(CLAUDE_CODE)).toBeUndefined();
        const refused = (await authorizeFor(taken.provider, CLAUDE_CODE))!;
        expect(refused.status).toBe(403);
        expect(await refused.text()).toContain("Claude Code is not accepted here");
      });
    });

    it("shows the sign-in page a client's sign-in sends someone to, signed in or not, which posts its signed request along", async () => {
      const consent = "/auth/consent?client_id=x&sig=z";
      const answers = {
        "/auth/better-auth/sign-in/email-otp": () => ({ status: 200, body: { redirect: true, url: consent } }),
      };
      const page = await signInPage(SIGNED, answers, "who=ada@acme.test");
      await page.email("ada@acme.test");
      await page.code("123456");
      expect(page.posted.at(-1)).toEqual({
        path: "/auth/better-auth/sign-in/email-otp",
        body: { email: "ada@acme.test", otp: "123456", oauth_query: new URLSearchParams(SIGNED).toString() },
      });
      // On where the half says: the consent page, or the client's redirect.
      expect(page.location.assign).toHaveBeenCalledWith(consent);
    });

    it("says a client's sign-in expired when the half no longer takes its signed request, and counts no wrong code", async () => {
      const gone = { status: 400, body: { error: "invalid_signature" } };
      let answer = gone;
      const page = await signInPage(SIGNED, {
        "/auth/better-auth/sign-in/email-otp": () => answer,
        "/auth/better-auth/sign-in/social": () => gone,
      });
      await page.email("ada@acme.test");
      for (let attempt = 0; attempt < 4; attempt++) {
        await page.code("123456");
        expect(page.message()).toBe(EXPIRED);
      }
      // A wrong code is still told as one, the first of three.
      answer = { status: 400, body: { code: "INVALID_OTP" } as never };
      await page.code("000000");
      expect(page.message()).toBe("That code did not work. Check it, or send a new one.");
      // The GitHub button's start is refused the same way.
      await page.github();
      expect(page.message()).toBe(EXPIRED);
      expect(page.location.assign).not.toHaveBeenCalled();
    });

    it("keeps a client's signed request through a GitHub sign-in that fails, so a code goes on with it", async () => {
      const github = { status: 200, body: { url: "https://github.com/login/oauth/authorize?state=s" } };
      // Back from GitHub with its error: the address is the signed request and `error`, which the half did not sign.
      const page = await signInPage(`${SIGNED}&error=not_declared`, {
        "/auth/better-auth/sign-in/social": () => github,
      });
      const signed = new URLSearchParams(SIGNED).toString();
      await page.github();
      expect(page.posted.at(-1)!.body).toEqual({
        provider: "github",
        callbackURL: "/",
        errorCallbackURL: `/auth/login?${signed}`,
        oauth_query: signed,
      });
      expect(page.location.href).toBe(github.body.url);
      await page.email("ada@acme.test");
      await page.code("123456");
      expect(page.posted.at(-1)!.body).toMatchObject({ oauth_query: signed });
      // With no client's sign-in, a failure comes back to the sign-in page alone, as before.
      const plain = await signInPage("error=not_declared", { "/auth/better-auth/sign-in/social": () => github });
      await plain.github();
      expect(plain.posted.at(-1)!.body).toEqual({
        provider: "github",
        callbackURL: "/",
        errorCallbackURL: "/auth/login",
      });
    });
  });

  it("listens on any host", () => {
    expect(() => login.check("0.0.0.0")).not.toThrow();
  });
});
