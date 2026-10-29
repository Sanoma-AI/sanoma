import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sanoma } from "@sanoma-ai/workflows/resources";
import type { AdmittingLogin, LoginProvider } from "../src/context.ts";
import { admitting } from "../src/login/admission.ts";
import { githubLogin } from "../src/login/github.ts";

// GitHub sign-in against a GitHub made of msw handlers: the token exchange and the user. Each
// test signs someone in through the provider's own routes; the people file admits them.

const github = setupServer(
  http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
    const { client_id, client_secret, code } = (await request.json()) as Record<string, string>;
    if (client_id !== "client-id" || client_secret !== "client-secret") return new HttpResponse(null, { status: 401 });
    // GitHub answers a used or expired code with 200 and an error.
    if (code === "used") return HttpResponse.json({ error: "bad_verification_code" });
    return HttpResponse.json({ access_token: `token-${code}`, token_type: "bearer" });
  }),
  http.get("https://api.github.com/user", ({ request }) =>
    HttpResponse.json({ login: request.headers.get("authorization")?.replace("Bearer token-", ""), id: 1 }),
  ),
);

beforeAll(() => github.listen({ onUnhandledFrame: "error" }));
afterEach(() => github.resetHandlers());
afterAll(() => github.close());

const APP = "https://sanoma.acme.example";

/** A request to the app, with these cookies. */
const request = (path: string, { cookie = "", method = "GET" } = {}) =>
  new Request(new URL(path, APP), { method, headers: cookie ? { cookie } : {} });

/** The `name=value` pairs a response sets, by name. */
const setCookies = (res: Response) =>
  Object.fromEntries(res.headers.getSetCookie().map((line) => line.split(";")[0]!.split(/=(.*)/s).slice(0, 2)));

/** The session cookie a callback set, as a request sends it back. */
const session = (res: Response) => `sanoma_session=${setCookies(res).sanoma_session}`;

describe("githubLogin", () => {
  let login: LoginProvider;
  beforeEach(() => {
    vi.stubEnv("SANOMA_SIGNING_KEY", Buffer.alloc(32, 1).toString("base64"));
    login = githubLogin({ clientId: "client-id", clientSecret: "client-secret" });
  });
  afterEach(() => vi.unstubAllEnvs());

  /** Starts a sign-in, comes back from GitHub with `code` for `user`, and returns the callback's response. */
  async function signIn(user: string, { state }: { state?: string } = {}): Promise<Response> {
    const start = (await login.handle!(request("/auth/github/start")))!;
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("client-id");
    const sent = to.searchParams.get("state")!;
    // The browser sends the state cookie back only to paths under its own.
    const path = /Path=([^;]+)/.exec(start.headers.get("set-cookie")!)?.[1];
    expect("/auth/github/callback".startsWith(`${path}/`)).toBe(true);
    const cookie = `sanoma_github_state=${setCookies(start).sanoma_github_state}`;
    return (await login.handle!(request(`/auth/github/callback?code=${user}&state=${state ?? sent}`, { cookie })))!;
  }

  it("signs in whoever GitHub says, and resolveActor returns their login, whatever their access to the repository", async () => {
    const res = await signIn("writer");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/sanoma_session=[\w-]+\.\d+\.[\w-]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect(set).toMatch(/sanoma_github_state=; Max-Age=0/);
    const signedIn = request("/workflows", { cookie: session(res) });
    expect(await login.resolveActor(signedIn)).toEqual({ github: "writer" });
    // The app answers the page: the login has nothing to say.
    expect(await login.handle!(signedIn)).toBeUndefined();
  });

  it("refuses a callback whose state is not the one it set, and a code GitHub refuses", async () => {
    const forged = await signIn("writer", { state: "forged" });
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("did not start here");
    const used = await signIn("used");
    expect(used.status).toBe(400);
    expect(await used.text()).toContain("GitHub did not sign you in");
  });

  it("rejects a tampered cookie, and one signed with another key", async () => {
    const cookie = session(await signIn("writer"));
    const [, value] = cookie.split("=");
    const [, expires, mac] = value!.split(".");
    const admin = Buffer.from(JSON.stringify({ login: "admin", id: 1 })).toString("base64url");
    const [user] = value!.split(".");
    const tampered = [
      `sanoma_session=${admin}.${expires}.${mac}`,
      `sanoma_session=${user}.${Number(expires) + 1}.${mac}`,
    ];
    for (const bad of tampered) {
      expect(await login.resolveActor(request("/", { cookie: bad }))).toBeUndefined();
      expect((await login.handle!(request("/", { cookie: bad })))?.status).toBe(401);
    }
    vi.stubEnv("SANOMA_SIGNING_KEY", Buffer.alloc(32, 2).toString("base64"));
    const other = githubLogin({ clientId: "client-id", clientSecret: "client-secret" });
    expect(await other.resolveActor(request("/", { cookie }))).toBeUndefined();
  });

  it("rejects an expired session", async () => {
    const cookie = session(await signIn("writer"));
    vi.useFakeTimers({ now: Date.now() + 13 * 60 * 60 * 1000 });
    try {
      expect(await login.resolveActor(request("/", { cookie }))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the sign-in page to a page request without a session, and a 401 to a server function", async () => {
    const page = (await login.handle!(request("/workflows")))!;
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain('<a href="/auth/github/start">Sign in with GitHub</a>');
    const fn = (await login.handle!(request("/_serverFn/abc", { method: "POST" })))!;
    expect(fn.status).toBe(401);
    expect(await fn.json()).toEqual({ error: "Sign in first" });
    expect(await login.resolveActor(request("/workflows"))).toBeUndefined();
  });

  it("signs out with a POST from its own page, clearing the session cookie", async () => {
    expect((await login.handle!(request("/auth/github/signout")))?.status).toBe(405);
    const crossSite = new Request(new URL("/auth/github/signout", APP), {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect((await login.handle!(crossSite))?.status).toBe(403);
    expect(login.signOut).toBe("/auth/github/signout");
    const res = (await login.handle!(request("/auth/github/signout", { method: "POST" })))!;
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^sanoma_session=; Max-Age=0; Path=\//);
  });

  it("refuses to start without SANOMA_SIGNING_KEY, naming it", () => {
    vi.stubEnv("SANOMA_SIGNING_KEY", "");
    expect(() => githubLogin({ clientId: "id", clientSecret: "secret" })).toThrow(/SANOMA_SIGNING_KEY/);
  });

  describe("admitting only declared people", () => {
    const ada = sanoma.person({ id: "ada", github: "Writer" });
    const bo = sanoma.person({ id: "bo", email: "bo@acme.test", github: "stranger" });
    const people = [ada, bo, sanoma.agent({ id: "bot" }), sanoma.group({ name: "finance", members: [ada] })];
    let admitted: AdmittingLogin;
    beforeEach(() => {
      admitted = admitting(login, () => ({ people, problems: [] }));
    });

    it("takes a declared person's login, ignoring case, as the declared principal", async () => {
      const cookie = session(await signIn("writer"));
      expect(await admitted.resolveActor(request("/", { cookie }))).toEqual({ id: "ada", groups: ["finance"] });
      expect(await admitted.handle!(request("/workflows", { cookie }))).toBeUndefined();
    });

    it("matches a verified email before a login", async () => {
      github.use(
        http.get("https://api.github.com/user", () =>
          HttpResponse.json({ login: "writer", id: 7, email: "BO@acme.test" }),
        ),
      );
      const cookie = session(await signIn("writer"));
      expect(await admitted.resolveActor(request("/", { cookie }))).toEqual({ id: "bo", groups: [] });
    });

    it("refuses anyone else: a page for a page, JSON not_admitted for a server function or a change", async () => {
      const cookie = session(await signIn("nobody"));
      expect(await admitted.resolveActor(request("/", { cookie }))).toBeUndefined();
      const page = (await admitted.handle!(request("/workflows", { cookie })))!;
      expect(page.status).toBe(403);
      expect(await page.text()).toContain("nobody is not declared in resources/people.ts. Ask");
      for (const call of [request("/_serverFn/abc", { cookie }), request("/workflows", { cookie, method: "POST" })]) {
        const res = (await admitted.handle!(call))!;
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: "nobody is not declared in resources/people.ts",
          code: "not_admitted",
        });
      }
      // Its own routes and the sign-in page still answer.
      expect((await admitted.handle!(request("/workflows")))?.status).toBe(401);
      expect((await admitted.handle!(request("/auth/github/start")))?.status).toBe(302);
    });

    it("admits nobody while no person is declared: GitHub names no id to take as given", async () => {
      const cookie = session(await signIn("writer"));
      expect(
        await admitting(login, () => ({ people: [], problems: [] })).resolveActor(request("/", { cookie })),
      ).toBeUndefined();
    });
  });

  it("listens on any host", () => {
    expect(() => login.check("0.0.0.0")).not.toThrow();
  });
});
