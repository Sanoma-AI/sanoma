// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { CredentialStatus, Principal } from "@sanoma-ai/workflows";
import { ApiError, type SetCredentialRequest, type SetupStatus } from "../api.ts";
import type { AppContext } from "../context.ts";
import { cookie, cookies } from "../login/github.ts";

// Going live, step 1: connect GitHub and Supabase. GitHub through an App the company creates
// with GitHub's manifest flow (`/setup/github/manifest`, then `/setup/github/callback`), whose
// keys are stored as encrypted credentials; or, for a personal account, a token of the person's
// own. Supabase through a pasted access token. Nothing here sends a stored value to a page.

/** Where the App's keys are stored, by what GitHub's conversion calls them. `githubLogin` reads the client's. */
export const GITHUB_APP = {
  id: "SANOMA_GITHUB_APP_ID",
  slug: "SANOMA_GITHUB_APP_SLUG",
  client_id: "SANOMA_GITHUB_CLIENT_ID",
  client_secret: "SANOMA_GITHUB_CLIENT_SECRET",
  webhook_secret: "SANOMA_GITHUB_WEBHOOK_SECRET",
  pem: "SANOMA_GITHUB_APP_PEM",
} as const;

/** The tokens the page takes, pasted: the connectors' own variables, so their pages show the same rows. */
export const SETUP_TOKENS: Record<string, string> = {
  GITHUB_TOKEN:
    "A GitHub token of your own, for a personal account: an installation token cannot create a repository there. Needs the repo scope.",
  SUPABASE_ACCESS_TOKEN: "A Supabase access token (supabase.com/dashboard/account/tokens).",
};

const CALLBACK = "/setup/github/callback";
const CONNECT = "/setup/connect";
/** The state cookie, sent only to the manifest and callback routes. */
const STATE = "sanoma_setup_state";
const STATE_PATH = "/setup/github";
const API = "https://api.github.com";

/** What the page shows: the App's slug, and each token's status; never a value. */
export async function setupStatus({ client }: AppContext): Promise<SetupStatus> {
  const found = await client.secrets([GITHUB_APP.slug, ...Object.keys(SETUP_TOKENS)]);
  const slug = found.get(GITHUB_APP.slug);
  const tokens = Object.entries(SETUP_TOKENS).map(([name, description]): CredentialStatus => {
    const secret = found.get(name);
    if (!secret) return { name, description, optional: false, status: "missing" };
    const { source, setBy, setAt } = secret;
    return { name, description, optional: false, status: "set", source, ...(setBy && { setBy, setAt }) };
  });
  return { githubApp: slug ? { slug: slug.value, setBy: slug.setBy, setAt: slug.setAt } : null, tokens };
}

/** Stores a pasted token as the actor: one of `SETUP_TOKENS` only. */
export async function setSetupToken({ client }: AppContext, actor: Principal, { name, value }: SetCredentialRequest) {
  if (!Object.hasOwn(SETUP_TOKENS, name)) {
    const error = `${name} is not a setup token; they are ${Object.keys(SETUP_TOKENS).join(", ")}`;
    throw new ApiError(400, {
      error,
      code: "invalid_input",
      issues: [{ path: ["name"], message: error, code: "custom" }],
    });
  }
  await client.setSecret(name, value, { by: actor.id });
}

/** The manifest the App is created from: its OAuth callback is the login's, its webhook this app's. */
export function githubManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    redirect_url: `${origin}${CALLBACK}`,
    callback_urls: [`${origin}/auth/github/callback`],
    hook_attributes: { url: `${origin}/webhooks/github` },
    public: false,
    default_permissions: {
      administration: "write",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: ["push", "pull_request"],
  };
}

/**
 * `GET /setup/github/manifest[?org=<login>]`: a page that posts the App's manifest to GitHub at
 * once (to the organization's settings with `org`), and the signed state cookie the callback
 * checks. The person names and creates the App on GitHub's page.
 */
export function manifestPage({ description }: AppContext, request: Request): Response {
  const url = new URL(request.url);
  const org = url.searchParams.get("org")?.trim();
  if (org && !/^[\w-]+$/.test(org)) return toConnect("bad-org");
  const state = randomBytes(16).toString("base64url");
  const to = new URL(
    org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  );
  to.searchParams.set("state", state);
  const manifest = JSON.stringify(githubManifest(url.origin, `Sanoma ${description.appName}`.slice(0, 34)));
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create the GitHub App · Sanoma</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<form id="manifest" method="post" action="${escape(to.toString())}">` +
    `<input type="hidden" name="manifest" value="${escape(manifest)}">` +
    `<p>Taking you to GitHub to create the App…</p><button type="submit">Continue to GitHub</button></form>` +
    `<script>document.getElementById("manifest").submit()</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": cookie(request, STATE, `${state}.${sign(state)}`, STATE_PATH, 600),
    },
  });
}

/**
 * `GET /setup/github/callback?code&state`: where GitHub sends the person back once the App is
 * created. Checks the state against the signed cookie, exchanges the code for the App's keys, and
 * stores them, then goes back to the connect page, which says how it went.
 */
export async function githubCallback(app: AppContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const [sent, signature] = (cookies(request)[STATE] ?? "").split(".");
  if (!code || !state || !sent || !signature || sent !== state || !same(signature, sign(sent))) {
    return toConnect("expired", request);
  }
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "sanoma" },
  });
  if (!res.ok) {
    console.error(`sanoma app: GitHub answered ${res.status} for the App's manifest conversion`);
    return toConnect("failed", request);
  }
  const keys = (await res.json()) as Record<keyof typeof GITHUB_APP, unknown> & { owner?: { login?: string } };
  const by = (await app.login.resolveActor(request))?.id ?? keys.owner?.login ?? "github";
  for (const [field, name] of Object.entries(GITHUB_APP)) {
    const value = keys[field as keyof typeof GITHUB_APP];
    if (value !== null && value !== undefined) await app.client.setSecret(name, String(value), { by });
  }
  return toConnect("connected", request);
}

/** Back to the connect page, saying how the App's creation went; the state cookie cleared. */
function toConnect(github: "connected" | "expired" | "failed" | "bad-org", request?: Request): Response {
  const headers = new Headers({ location: `${CONNECT}?github=${github}` });
  if (request) headers.append("set-cookie", cookie(request, STATE, "", STATE_PATH, 0));
  return new Response(null, { status: 303, headers });
}

/** The state's signature, under a key derived from `SANOMA_SECRETS_KEY`, which storing the App's keys needs anyway. */
function sign(state: string): string {
  const secretsKey = process.env.SANOMA_SECRETS_KEY;
  if (!secretsKey) throw new Error("Connecting GitHub needs SANOMA_SECRETS_KEY, which encrypts the App's keys");
  const key = Buffer.from(hkdfSync("sha256", secretsKey, "", "sanoma setup state", 32));
  return createHmac("sha256", key).update(state).digest("base64url");
}

function same(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
