import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { parse, serialize } from "cookie-es";
import type { LoginProvider } from "../context.ts";
import { smallPage, wantsJson } from "./page.ts";

// Sign-in with GitHub: GitHub's OAuth web flow, then a signed session cookie. GitHub says who is
// signing in, nothing more: who may is the people file (`admitting`), so a declared person signs
// in whether or not they can see the company's repository.

export interface GithubLoginOptions {
  /**
   * The OAuth client of the company's GitHub App. GitHub sends people back to the callback URL
   * registered with it: `<the app's URL>/auth/github/callback`.
   */
  clientId: string;
  clientSecret: string;
}

/** Who a session names, as GitHub's `/user` said when they signed in. */
interface GithubUser {
  login: string;
  id: number;
  email?: string;
}

const START = "/auth/github/start";
const CALLBACK = "/auth/github/callback";
const SIGN_OUT = "/auth/github/signout";
/** The state cookie's path: sent to the callback, which reads it, and to start, which sets it. */
const STATE_PATH = "/auth/github";
const SESSION = "sanoma_session";
const STATE = "sanoma_github_state";
/** How long a sign-in lasts. Who may sign in is read on every request (`admitting`), so removing someone takes effect at once. */
const SESSION_SECONDS = 12 * 60 * 60;
const API = "https://api.github.com";

/**
 * Signs people in with GitHub: `resolveActor` returns `{ github: <their login>, email }`, their
 * public email (one GitHub has verified) when they show one, which the app matches to a declared
 * person (`admitting`). The session lives in a cookie signed with a key
 * derived from `SANOMA_SECRETS_KEY`, which must be set. Routes: `/auth/github/start`,
 * `/auth/github/callback`, and `/auth/github/signout` (POST); any other request without a session
 * gets the sign-in page (a 401).
 */
export function githubLogin({ clientId, clientSecret }: GithubLoginOptions): LoginProvider {
  const secretsKey = process.env.SANOMA_SECRETS_KEY;
  if (!secretsKey) throw new Error("GitHub sign-in needs SANOMA_SECRETS_KEY, which signs its session cookie");
  const { sign: mac, verify } = signer(secretsKey, "sanoma session cookie");

  /** The user a request's session cookie names: signed here and not expired. */
  function signedIn(request: Request): GithubUser | undefined {
    const [user, expires, signature, ...rest] = (cookies(request)[SESSION] ?? "").split(".");
    if (!user || !expires || !signature || rest.length) return undefined;
    if (!verify(`${user}.${expires}`, signature) || Number(expires) <= Date.now() / 1000) return undefined;
    try {
      return JSON.parse(Buffer.from(user, "base64url").toString()) as GithubUser;
    } catch {
      // A session of another shape (an older version's): sign in again.
      return undefined;
    }
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== cookies(request)[STATE]) {
      return page(400, "That sign-in link has expired or did not start here.");
    }
    const token = await accessToken(code);
    if (!token) return page(400, "GitHub did not sign you in.");
    const { login, id, email } = (await api(token, "/user")) as { login: string; id: number; email?: string | null };
    const clearState = cookie(request, STATE, "", STATE_PATH, 0);
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    // Their numeric id too, which outlasts a renamed login: kept for matching by it later.
    const user = Buffer.from(JSON.stringify({ login, id, ...(email && { email }) } satisfies GithubUser)).toString(
      "base64url",
    );
    const value = `${user}.${expires}.${mac(`${user}.${expires}`)}`;
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

  return {
    name: "github",
    check() {},
    signOut: SIGN_OUT,
    resolveActor(request) {
      const user = signedIn(request);
      return user && { github: user.login, ...(user.email && { email: user.email }) };
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
      if (wantsJson(request)) {
        return Response.json({ error: "Sign in first" }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      return page(401, "Sign in to use this app.");
    },
  };
}

/** A GitHub API read as the user. */
async function api(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "sanoma",
    },
  });
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

/** The sign-in page, saying `message` (HTML). */
const page = (status: number, message: string) =>
  smallPage(status, "Sign in", `<p>${message}</p><p><a href="${START}">Sign in with GitHub</a></p>`);
