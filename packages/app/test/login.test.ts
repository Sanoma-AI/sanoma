import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginProvider } from "../src/context.ts";
import { githubLogin } from "../src/login/github.ts";

// GitHub sign-in against a GitHub made of msw handlers: the token exchange, the user, and their
// permission on the repository. Each test signs someone in through the provider's own routes.

const REPO = "acme/company";
/** Each user's token, and their permission on REPO; one not listed is no collaborator (404). */
const PERMISSIONS: Record<string, string> = { writer: "write", maintainer: "maintain", reader: "read" };

const github = setupServer(
  http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
    const { client_id, client_secret, code } = (await request.json()) as Record<string, string>;
    if (client_id !== "client-id" || client_secret !== "client-secret") return new HttpResponse(null, { status: 401 });
    // GitHub answers a used or expired code with 200 and an error.
    if (code === "used") return HttpResponse.json({ error: "bad_verification_code" });
    return HttpResponse.json({ access_token: `token-${code}`, token_type: "bearer" });
  }),
  http.get("https://api.github.com/user", ({ request }) =>
    HttpResponse.json({ login: request.headers.get("authorization")?.replace("Bearer token-", "") }),
  ),
  http.get("https://api.github.com/repos/acme/company/collaborators/:login/permission", ({ params, request }) => {
    const login = String(params.login);
    if (request.headers.get("authorization") !== `Bearer token-${login}`)
      return new HttpResponse(null, { status: 401 });
    const permission = PERMISSIONS[login];
    return permission
      ? HttpResponse.json({ permission, role_name: permission })
      : new HttpResponse(null, { status: 404 });
  }),
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
    vi.stubEnv("SANOMA_SECRETS_KEY", "a test key");
    login = githubLogin({ clientId: "client-id", clientSecret: "client-secret", repo: REPO });
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
    const cookie = `sanoma_github_state=${setCookies(start).sanoma_github_state}`;
    return (await login.handle!(request(`/auth/github/callback?code=${user}&state=${state ?? sent}`, { cookie })))!;
  }

  it("admits a collaborator with write access, and resolveActor returns their login", async () => {
    const res = await signIn("writer");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/sanoma_session=writer\.\d+\.[\w-]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect(set).toMatch(/sanoma_github_state=; Max-Age=0/);
    const signedIn = request("/workflows", { cookie: session(res) });
    expect(await login.resolveActor(signedIn)).toEqual({ id: "writer" });
    // The app answers the page: the login has nothing to say.
    expect(await login.handle!(signedIn)).toBeUndefined();
  });

  it("admits maintain too", async () => {
    const res = await signIn("maintainer");
    expect(await login.resolveActor(request("/", { cookie: session(res) }))).toEqual({ id: "maintainer" });
  });

  it("refuses read-only access and a non-collaborator with a 403, and sets no session", async () => {
    for (const user of ["reader", "stranger"]) {
      const res = await signIn(user);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(`${user} needs write access to ${REPO}`);
      expect(setCookies(res).sanoma_session).toBeUndefined();
    }
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
    const tampered = [`sanoma_session=admin.${expires}.${mac}`, `sanoma_session=writer.${Number(expires) + 1}.${mac}`];
    for (const bad of tampered) {
      expect(await login.resolveActor(request("/", { cookie: bad }))).toBeUndefined();
      expect((await login.handle!(request("/", { cookie: bad })))?.status).toBe(401);
    }
    vi.stubEnv("SANOMA_SECRETS_KEY", "another key");
    const other = githubLogin({ clientId: "client-id", clientSecret: "client-secret", repo: REPO });
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

  it("signs out with a POST, clearing the session cookie", async () => {
    expect((await login.handle!(request("/auth/github/signout")))?.status).toBe(405);
    const res = (await login.handle!(request("/auth/github/signout", { method: "POST" })))!;
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^sanoma_session=; Max-Age=0; Path=\//);
  });

  it("refuses to start without SANOMA_SECRETS_KEY, naming it, or with a repository that is not owner/name", () => {
    vi.stubEnv("SANOMA_SECRETS_KEY", "");
    expect(() => githubLogin({ clientId: "id", clientSecret: "secret", repo: REPO })).toThrow(/SANOMA_SECRETS_KEY/);
    vi.stubEnv("SANOMA_SECRETS_KEY", "a test key");
    expect(() => githubLogin({ clientId: "id", clientSecret: "secret", repo: "company" })).toThrow(/owner\/name/);
  });

  it("listens on any host", () => {
    expect(() => login.check("0.0.0.0")).not.toThrow();
  });
});
