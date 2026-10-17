import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { parse, serialize } from "cookie-es";
import type { LoginProvider } from "../context.ts";

// Sign-in with GitHub: GitHub's OAuth web flow, then a signed session cookie. Who may sign in is
// whoever has write access or more on the company's repository, read once, as they sign in.

export interface GithubLoginOptions {
  /**
   * The OAuth client of the company's GitHub App, installed on `repo` (Metadata: read). GitHub
   * sends people back to the callback URL registered with it: `<the app's URL>/auth/github/callback`.
   * An OAuth App's token, asked for no scope, cannot read a private repository's permissions.
   */
  clientId: string;
  clientSecret: string;
  /** `owner/name`: the repository whose collaborators with write, maintain or admin may sign in. */
  repo: string;
}

const START = "/auth/github/start";
const CALLBACK = "/auth/github/callback";
const SIGN_OUT = "/auth/github/signout";
/** The state cookie's path: sent to the callback, which reads it, and to start, which sets it. */
const STATE_PATH = "/auth/github";
const SESSION = "sanoma_session";
const STATE = "sanoma_github_state";
/** How long a sign-in lasts. Access is read as one signs in, so a revoked collaborator keeps it until then. */
const SESSION_SECONDS = 12 * 60 * 60;
const ADMITTED = new Set(["admin", "maintain", "write"]);
const API = "https://api.github.com";

/**
 * Signs people in with GitHub and admits a collaborator on `repo` with write access or more:
 * `resolveActor` returns `{ id: <their login> }`. The session lives in a cookie signed with a key
 * derived from `SANOMA_SECRETS_KEY`, which must be set. Routes: `/auth/github/start`,
 * `/auth/github/callback`, and `/auth/github/signout` (POST); any other request without a session
 * gets the sign-in page (a 401).
 */
export function githubLogin({ clientId, clientSecret, repo }: GithubLoginOptions): LoginProvider {
  const secretsKey = process.env.SANOMA_SECRETS_KEY;
  if (!secretsKey) throw new Error("GitHub sign-in needs SANOMA_SECRETS_KEY, which signs its session cookie");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`GitHub sign-in: the repository is "owner/name", not "${repo}"`);
  const { sign: mac, verify } = signer(secretsKey, "sanoma session cookie");

  /** The login a request's session cookie names: signed here and not expired. */
  function signedIn(request: Request): string | undefined {
    const [login, expires, signature, ...rest] = (cookies(request)[SESSION] ?? "").split(".");
    if (!login || !expires || !signature || rest.length) return undefined;
    if (!verify(`${login}.${expires}`, signature)) return undefined;
    return Number(expires) > Date.now() / 1000 ? login : undefined;
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== cookies(request)[STATE]) {
      return page(400, "That sign-in link has expired or did not start here.", true);
    }
    const token = await accessToken(code);
    if (!token) return page(400, "GitHub did not sign you in.", true);
    const { login } = (await api(token, "/user")) as { login: string };
    const clearState = cookie(request, STATE, "", STATE_PATH, 0);
    if (!ADMITTED.has(await permission(token, login))) {
      const denied = page(403, `${login} needs write access to ${repo} to use this app.`, false);
      denied.headers.append("set-cookie", clearState);
      return denied;
    }
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const value = `${login}.${expires}.${mac(`${login}.${expires}`)}`;
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", clearState);
    headers.append("set-cookie", cookie(request, SESSION, value, "/", SESSION_SECONDS));
    return new Response(null, { status: 303, headers });
  }

  /** The user's token for a callback's code, or undefined when GitHub refuses the code (used, expired). */
  async function accessToken(code: string): Promise<string | undefined> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) throw new Error(`GitHub's token exchange answered ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    return body.access_token || undefined;
  }

  /** The user's permission on the repository; `none` when GitHub will not show them it (403, 404). */
  async function permission(token: string, login: string): Promise<string> {
    const body = (await api(token, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, true)) as
      | { permission?: string }
      | undefined;
    return body?.permission ?? "none";
  }

  return {
    name: "github",
    check() {},
    signOut: SIGN_OUT,
    resolveActor(request) {
      const login = signedIn(request);
      return login ? { id: login } : undefined;
    },
    async handle(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case START: {
          const state = randomBytes(16).toString("base64url");
          const to = new URL("https://github.com/login/oauth/authorize");
          to.search = new URLSearchParams({ client_id: clientId, state }).toString();
          const headers = new Headers({ location: to.toString() });
          headers.append("set-cookie", cookie(request, STATE, state, STATE_PATH, 600));
          return new Response(null, { status: 302, headers });
        }
        case CALLBACK:
          return callback(request, url);
        case SIGN_OUT: {
          if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
          // Only the app's own page signs you out.
          if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403 });
          return new Response(null, { status: 204, headers: { "set-cookie": cookie(request, SESSION, "", "/", 0) } });
        }
      }
      if (signedIn(request)) return undefined;
      // The page's server functions get JSON; anything else the sign-in page.
      if (url.pathname.startsWith("/_serverFn/") || (request.method !== "GET" && request.method !== "HEAD")) {
        return Response.json({ error: "Sign in first" }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      return page(401, "Sign in to use this app.", true);
    },
  };
}

/** A GitHub API read as the user; undefined for a 403 or 404 (no access) when `missingIsNone`. */
async function api(token: string, path: string, missingIsNone = false): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "sanoma",
    },
  });
  if (missingIsNone && (res.status === 403 || res.status === 404)) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for GET ${path}`);
  return res.json();
}

/**
 * Signs short values (a session, a state) with a key derived from `SANOMA_SECRETS_KEY` for
 * `purpose`, so each use has a key of its own; `verify` compares in constant time.
 */
export function signer(secretsKey: string, purpose: string) {
  const key = Buffer.from(hkdfSync("sha256", secretsKey, "", purpose, 32));
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  const verify = (payload: string, signature: string) => {
    const [expected, given] = [Buffer.from(sign(payload)), Buffer.from(signature)];
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return { sign, verify };
}

export const cookies = (request: Request) => parse(request.headers.get("cookie") ?? "");

/**
 * A Set-Cookie line (`maxAge` 0 clears it): httpOnly, Lax, and Secure when the request came over
 * HTTPS (directly or through a proxy that says so).
 */
export const cookie = (request: Request, name: string, value: string, path: string, maxAge: number) =>
  serialize(name, value, {
    path,
    maxAge,
    httpOnly: true,
    sameSite: "lax",
    secure: request.url.startsWith("https:") || request.headers.get("x-forwarded-proto") === "https",
  });

/** A small page of its own: the app's pages are for people signed in. */
function page(status: number, message: string, signIn: boolean): Response {
  const link = signIn ? `<p><a href="${START}">Sign in with GitHub</a></p>` : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Sign in · Sanoma</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<p>${message}</p>${link}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
