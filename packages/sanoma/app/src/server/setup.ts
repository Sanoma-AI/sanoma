// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { randomBytes } from "node:crypto";
import { type CredentialStatus, GITHUB_APP, isLoopback, type Principal } from "sanoma/workflows";
import { credentialReady } from "sanoma/workflows/shared";
import { mintInstanceToken, WAKEUP_TOKEN } from "sanoma/workflows/wakeup-service";
import { type SetCredentialRequest, SETUP_VENDORS, type SetupStatus } from "../api.ts";
import type { AppContext } from "../context.ts";
import { type ActorContext, invalid } from "./core.ts";
import { declaredEmail } from "./people.ts";
import { actorCookie, cookie, cookies } from "../login/keys.ts";
import { escapeHtml } from "../login/page.ts";
import { secretValues } from "./secrets.ts";

// Going live, step 1: connect GitHub, and each vendor of a database, host or wakeup the config
// declares: Supabase or Neon, Cloudflare, a wakeup service. GitHub through an App the company creates
// with GitHub's manifest flow (`/setup/github/manifest`, then `/setup/github/callback`), whose
// keys are stored as encrypted credentials; or, for a personal account, a token of the person's
// own. The others through a pasted token. Nothing here sends a stored value to a page.

/** Where the App's keys are stored, by what GitHub's conversion calls them: the one list, `sanoma/workflows`'. */
export { GITHUB_APP };

/** A wakeup service's account token, which "Connect a wakeup service" stores. */
export const WAKEUP_ACCOUNT_TOKEN = "SANOMA_WAKEUP_ACCOUNT_TOKEN";
/** The wakeup service's URL: the worker on the host registers there. */
export const WAKEUP_URL = "SANOMA_WAKEUP_URL";

/**
 * The tokens the page takes, pasted: the connectors' own variables, so their pages show the same
 * rows. One of a vendor's (`SETUP_VENDORS`) is asked for only when the config declares a type of
 * that vendor. Cloudflare's are optional: going live runs the company there once both are
 * stored, and on Docker without them. Agent37's is too: going live declares the coding agents'
 * box there once it is stored.
 */
export const SETUP_TOKENS: Record<string, { description: string; optional?: true }> = {
  GITHUB_TOKEN: {
    description:
      "A GitHub token of your own, for a personal account: an installation token cannot create a repository there. Needs the repo scope.",
  },
  SUPABASE_ACCESS_TOKEN: {
    description: "A Supabase access token (supabase.com/dashboard/account/tokens).",
  },
  NEON_API_KEY: {
    description: "An organization API key, from console.neon.tech, Organization settings, API keys.",
  },
  CLOUDFLARE_API_TOKEN: {
    description:
      "An API token with Workers Scripts Edit, Workers Containers Edit and Account Settings Read, and Zone Read and Zone → DNS → Edit on the zones of custom domains and DNS records, from dash.cloudflare.com/profile/api-tokens.",
    optional: true,
  },
  CLOUDFLARE_ACCOUNT_ID: {
    description: "The account id, from the Workers & Pages overview.",
    optional: true,
  },
  AGENT37_API_KEY: {
    description:
      "Optional: an Agent37 API key (sk_live_…), from agent37.com's Cloud API keys page, so that coding agents work in a box of their own.",
    optional: true,
  },
  [WAKEUP_URL]: {
    description:
      "Optional: a wakeup service's URL, Sanoma's or your own `sanoma wakeup`, reachable from the host: it starts the company again when something is due after it stopped.",
    optional: true,
  },
  [WAKEUP_ACCOUNT_TOKEN]: {
    description:
      "Optional: an account's token at that service (swa_…), from Sanoma, or from `sanoma wakeup account <label>` on a service of your own.",
    optional: true,
  },
};

/** The vendor a setup token is for, when it is a vendor's (`SETUP_VENDORS`). */
const vendorOf = (name: string) => SETUP_VENDORS.find((v) => v.tokens.includes(name))?.vendor;

/**
 * The identity enrollment writer's URL, when the config names it with `secret()`
 * (`identityProvisioning.databaseUrl`): asked for here, under that name, until it is stored.
 */
const ENROLLMENT_WRITER: (typeof SETUP_TOKENS)[string] = {
  description:
    "The enrollment writer's connection string (postgres://…): a restricted login on the identity enrollment database, through which Sanoma Cloud's sign-up enrolls each company's deployment credential. Until it is stored, enrollment says the writer is not set.",
};

/** The setup tokens this config asks for, the enrollment writer's last. */
const setupTokens = ({ resolved }: AppContext) => {
  const vendors = new Set([...resolved.types.values()].map((type) => type.vendor));
  const writer = resolved.identityProvisioning.secret;
  return [
    ...Object.keys(SETUP_TOKENS).filter((name) => {
      const vendor = vendorOf(name);
      // A connector with authentication methods is configured through named account intake.
      // Never offer its former global token field as a second way to connect it.
      return (
        vendor === undefined ||
        (vendors.has(vendor) && !Object.keys(resolved.connections.catalog.methods.get(vendor) ?? {}).length)
      );
    }),
    ...(writer ? [writer] : []),
  ];
};

const CALLBACK = "/setup/github/callback";
const CONNECT = "/hosting/connect";
/** The state cookie, sent only to the manifest and callback routes. */
const STATE = "sanoma_setup_state";
const STATE_PATH = "/setup/github";
const API = "https://api.github.com";
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "sanoma",
};

/** The permissions the manifest asks for, which `missingPermissions` holds a stored App to. */
const GITHUB_APP_PERMISSIONS = {
  administration: "write",
  contents: "write",
  // The staff login's "Sign in with GitHub" reads the person's verified emails.
  emails: "read",
  metadata: "read",
  pull_requests: "write",
  // The `sanoma` commit status a change's review sets.
  statuses: "write",
} as const;
const LEVEL = { none: 0, read: 1, write: 2 } as const;
/** GitHub's listing of each stored App, by slug, kept a while: it changes only when someone edits the App. */
const listings = new Map<string, { at: number; missing: string[] }>();
const LISTING_MS = 10 * 60_000;

/**
 * The permissions of `GITHUB_APP_PERMISSIONS` that the stored App `slug` lacks (a granted write
 * covers a needed read), as `<name>: <level>`, from the GitHub connector's remote half, which
 * reads GitHub's listing as the App with its stored keys; null when the connector has no remote
 * half here, the keys are not stored, or GitHub did not say in time.
 */
async function missingPermissions(app: AppContext, slug: string): Promise<string[] | null> {
  const known = listings.get(slug);
  if (known && Date.now() - known.at < LISTING_MS) return known.missing;
  const remote = app.resolved.remotes.get("github");
  if (!remote?.permissions) return null;
  try {
    const permissions = await Promise.race([
      remote.permissions({ secrets: secretValues(app.client) }),
      new Promise<undefined>((resolve) =>
        AbortSignal.timeout(2_000).addEventListener("abort", () => resolve(undefined)),
      ),
    ]);
    if (!permissions) return null;
    const level = (name: string) => LEVEL[(permissions[name] ?? "none") as keyof typeof LEVEL] ?? 0;
    const missing = Object.entries(GITHUB_APP_PERMISSIONS)
      .filter(([name, needed]) => level(name) < LEVEL[needed])
      .map(([name, needed]) => `${name}: ${needed}`);
    listings.set(slug, { at: Date.now(), missing });
    return missing;
  } catch {
    return null;
  }
}

/** What the page shows: the App's slug, each token's status and how people will sign in on the host (`signIn`); never a value. */
export async function setupStatus(app: AppContext, actor?: Principal): Promise<SetupStatus> {
  const names = setupTokens(app);
  const writer = app.resolved.identityProvisioning.secret;
  const secrets = app.client.secrets([GITHUB_APP.slug, GITHUB_APP.client_id, GITHUB_APP.client_secret, ...names]);
  const [found, signIn, missing] = await Promise.all([
    secrets,
    signInStatus(app, actor),
    secrets.then((f) => {
      const slug = f.get(GITHUB_APP.slug);
      return slug ? missingPermissions(app, slug.value) : null;
    }),
  ]);
  const slug = found.get(GITHUB_APP.slug);
  const tokens = names.map((name): CredentialStatus => {
    const { description, optional = false } = name === writer ? ENROLLMENT_WRITER : SETUP_TOKENS[name]!;
    const secret = found.get(name);
    if (!secret) return { name, description, optional, status: "missing" };
    const { source, setBy, setAt } = secret;
    return { name, description, optional, status: "set", source, ...(setBy && { setBy, setAt }) };
  });
  return {
    githubApp: slug ? { slug: slug.value, setBy: slug.setBy, setAt: slug.setAt, missing } : null,
    tokens,
    ...(writer && { enrollmentWriter: writer }),
    signIn: { ...signIn, github: found.has(GITHUB_APP.client_id) && found.has(GITHUB_APP.client_secret) },
  };
}

/**
 * The declared email of the person asking, the config's sender, with whether its connector's
 * credentials are set, and the public sites with a login.
 */
async function signInStatus(app: AppContext, actor?: Principal) {
  const sender = app.resolved.login?.sender;
  const statuses = sender && (await app.client.credentials()).get(sender.vendor);
  return {
    you: (actor && declaredEmail(app, actor.id)) ?? null,
    sender: sender?.id ?? null,
    senderConnected: !!statuses?.every(credentialReady),
    sites: app.snapshot.description.sites.flatMap(({ name, public: open, login }) =>
      open && login !== undefined ? [{ name, login }] : [],
    ),
  };
}

/**
 * Stores a pasted token as the actor: one of the config's setup tokens only. Storing a wakeup
 * service's account token also mints the instance's own (`SANOMA_WAKEUP_TOKEN`) when none is stored, and a
 * new one for another account's, so going live can give the host it from the first apply, and the
 * wakeup's create registers it.
 */
export async function setSetupToken(app: AppContext, actor: Principal, { name, value }: SetCredentialRequest) {
  const names = setupTokens(app);
  if (!names.includes(name)) {
    invalid("name", `${name} is not a setup token; they are ${names.join(", ")}`);
  }
  const { client } = app;
  const account = name === WAKEUP_ACCOUNT_TOKEN;
  const before = account ? (await client.secrets([name])).get(name)?.value : undefined;
  await client.setSecret(name, value, { by: actor.id });
  // Another account's: the instance token the old one registered would be refused (a 409).
  if (account) await mintWakeupToken(client, actor, before !== undefined && before !== value);
}

/**
 * Mints the instance's own token (`SANOMA_WAKEUP_TOKEN`) when it is not stored, or again when
 * `fresh`, for a new account at the wakeup service: storing the account's token does, and going live, when
 * it declares a wakeup.
 */
export async function mintWakeupToken(client: AppContext["client"], actor: Principal, fresh = false) {
  if (fresh || !(await client.secrets([WAKEUP_TOKEN])).has(WAKEUP_TOKEN)) {
    await client.setSecret(WAKEUP_TOKEN, mintInstanceToken(), { by: actor.id });
  }
}

/**
 * The manifest the App is created from: its OAuth callback is the staff login's (Better Auth's),
 * its webhook this app's, on unless the app is on this machine, which GitHub cannot reach.
 */
export function githubManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    redirect_url: `${origin}${CALLBACK}`,
    callback_urls: [`${origin}/auth/better-auth/callback/github`],
    // `remoteWebhook` answers it: a push deploys or plans a change again, a closed pull request ends one.
    hook_attributes: { url: `${origin}/webhooks/github`, active: !isLoopback(new URL(origin).hostname) },
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: ["push", "pull_request"],
  };
}

/**
 * `GET /setup/github/manifest[?org=<login>]`: a page that posts the App's manifest to GitHub at
 * once (to the organization's settings with `org`), and the signed state cookie the callback
 * checks, which carries who asked: GitHub's redirect back does not bring the loopback login's
 * name, and the App's keys are stored as that person. The person names and creates the App on
 * GitHub's page. Nobody asking goes back to the connect page, which says so.
 */
export async function manifestPage(
  { app: { snapshot }, actor: resolve }: ActorContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const org = url.searchParams.get("org")?.trim();
  if (org && !/^[\w-]+$/.test(org)) return toConnect("bad-org");
  const actor = await resolve();
  if (!actor) return toConnect("nobody");
  const state = randomBytes(16).toString("base64url");
  const to = new URL(
    org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  );
  to.searchParams.set("state", state);
  const manifest = JSON.stringify(githubManifest(url.origin, `Sanoma ${snapshot.description.appName}`.slice(0, 34)));
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create the GitHub App · Sanoma</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<form id="manifest" method="post" action="${escapeHtml(to.toString())}">` +
    `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
    `<p>Taking you to GitHub to create the App…</p><button type="submit">Continue to GitHub</button></form>` +
    `<script>document.getElementById("manifest").submit()</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": cookie(request, STATE, stateCookie().seal(state, actor.id), STATE_PATH, 600),
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
  const sent = stateCookie().open(cookies(request)[STATE]);
  if (!code || !state || sent?.value !== state) return toConnect("expired", request);
  // Who started the flow, as the manifest page admitted them.
  const by = sent.actor;
  try {
    const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: GITHUB_HEADERS,
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const keys = (await res.json()) as Record<keyof typeof GITHUB_APP, unknown>;
    await Promise.all(
      Object.entries(GITHUB_APP).map(([field, name]) => {
        const value = keys[field as keyof typeof GITHUB_APP];
        return value === null || value === undefined ? undefined : app.client.setSecret(name, String(value), { by });
      }),
    );
  } catch (err) {
    // The code works once: the App may exist on GitHub with its keys not (all) stored here.
    console.error("sanoma app: the GitHub App's keys were not stored:", err);
    return toConnect("failed", request);
  }
  return toConnect("connected", request);
}

/** Back to the connect page, saying how the App's creation went; the state cookie cleared. */
function toConnect(github: "connected" | "expired" | "failed" | "bad-org" | "nobody", request?: Request): Response {
  const headers = new Headers({ location: `${CONNECT}?github=${github}` });
  if (request) headers.append("set-cookie", cookie(request, STATE, "", STATE_PATH, 0));
  return new Response(null, { status: 303, headers });
}

/** Signs setup state with the independent app-signing key. */
const stateCookie = () => actorCookie("sanoma setup state");
