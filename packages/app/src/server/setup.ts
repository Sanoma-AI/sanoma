// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { type CredentialStatus, errorMessage, memorySecrets, type Principal } from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret as secretOf } from "@sanoma-ai/workflows/resources";
import { mintInstanceToken, WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import {
  ApiError,
  type ConnectExistingRequest,
  type ConnectExistingResponse,
  INFRA,
  PASSWORD_NOTE,
  type SetCredentialRequest,
  type SetupStatus,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import type { ActorContext } from "./core.ts";
import { cookie, cookies } from "../login/github.ts";
import { signer } from "../login/keys.ts";
import { escapeHtml } from "../login/page.ts";

// Going live, step 1: connect GitHub, and each vendor of a database, host or wakeup the config
// declares: Supabase or Neon, Cloudflare, sanoma-ops. GitHub through an App the company creates
// with GitHub's manifest flow (`/setup/github/manifest`, then `/setup/github/callback`), whose
// keys are stored as encrypted credentials; or, for a personal account, a token of the person's
// own. The others through a pasted token. Nothing here sends a stored value to a page.

/** Where the App's keys are stored, by what GitHub's conversion calls them. `githubLogin` reads the client's. */
export const GITHUB_APP = {
  id: "SANOMA_GITHUB_APP_ID",
  slug: "SANOMA_GITHUB_APP_SLUG",
  client_id: "SANOMA_GITHUB_CLIENT_ID",
  client_secret: "SANOMA_GITHUB_CLIENT_SECRET",
  webhook_secret: "SANOMA_GITHUB_WEBHOOK_SECRET",
  pem: "SANOMA_GITHUB_APP_PEM",
} as const;

/** sanoma-ops's account token, which "Connect sanoma-ops" stores. */
export const OPS_TOKEN = "SANOMA_OPS_TOKEN";
/** The wakeup service's URL, when one is stored: the worker on the host registers there. */
export const OPS_URL = "SANOMA_OPS_URL";
/** Cloudflare's API token, which "Connect Cloudflare" stores. */
export const CLOUDFLARE_TOKEN = "CLOUDFLARE_API_TOKEN";

/**
 * The tokens the page takes, pasted: the connectors' own variables, so their pages show the same
 * rows. One with a `vendor` is asked for only when the config declares a resource type of that
 * vendor. Cloudflare's are optional: going live runs the company there once they are stored, and
 * on Docker without them.
 */
export const SETUP_TOKENS: Record<string, { description: string; optional?: true; vendor?: string }> = {
  GITHUB_TOKEN: {
    description:
      "A GitHub token of your own, for a personal account: an installation token cannot create a repository there. Needs the repo scope.",
  },
  SUPABASE_ACCESS_TOKEN: {
    description: "A Supabase access token (supabase.com/dashboard/account/tokens).",
    vendor: "supabase",
  },
  NEON_API_KEY: {
    description: "An organization API key, from console.neon.tech, Organization settings, API keys.",
    vendor: "neon",
  },
  [CLOUDFLARE_TOKEN]: {
    description:
      "An API token with Workers Scripts Edit, Workers Containers Edit and Account Settings Read, from dash.cloudflare.com/profile/api-tokens.",
    optional: true,
    vendor: "cloudflare",
  },
  CLOUDFLARE_ACCOUNT_ID: {
    description: "The account id, from the Workers & Pages overview.",
    optional: true,
    vendor: "cloudflare",
  },
  [OPS_TOKEN]: {
    description:
      "Optional: a wakeup account's token (swa_…), from Sanoma, or from `sanoma wakeup account <label>` on a wakeup service of your own: the wakeup starts the company again when something is due after it stopped.",
    optional: true,
    vendor: "sanomaOps",
  },
  [OPS_URL]: {
    description:
      "Optional: the wakeup service's URL, such as your own `sanoma wakeup`. Unset, the connector's default, Sanoma's hosted service.",
    optional: true,
    vendor: "sanomaOps",
  },
};

/**
 * The token whose being stored says a vendor is connected, for going live's choice of host and
 * wakeup: Cloudflare's host and its wakeup once its API token is, sanoma-ops's wakeup once its
 * account's token is.
 */
export const CONNECTED_BY: Record<string, string> = { cloudflare: CLOUDFLARE_TOKEN, sanomaOps: OPS_TOKEN };

/** The setup tokens this config asks for. */
const setupTokens = ({ resolved }: AppContext) => {
  const vendors = new Set([...resolved.types.values()].map((type) => type.vendor));
  return Object.keys(SETUP_TOKENS).filter((name) => {
    const { vendor } = SETUP_TOKENS[name]!;
    return vendor === undefined || vendors.has(vendor);
  });
};

const CALLBACK = "/setup/github/callback";
const CONNECT = "/setup/connect";
/** The state cookie, sent only to the manifest and callback routes. */
const STATE = "sanoma_setup_state";
const STATE_PATH = "/setup/github";
const API = "https://api.github.com";

/** What the page shows: the App's slug, and each token's status; never a value. */
export async function setupStatus(app: AppContext): Promise<SetupStatus> {
  const names = setupTokens(app);
  const found = await app.client.secrets([GITHUB_APP.slug, ...names]);
  const slug = found.get(GITHUB_APP.slug);
  const tokens = names.map((name): CredentialStatus => {
    const { description, optional = false } = SETUP_TOKENS[name]!;
    const secret = found.get(name);
    if (!secret) return { name, description, optional, status: "missing" };
    const { source, setBy, setAt } = secret;
    return { name, description, optional, status: "set", source, ...(setBy && { setBy, setAt }) };
  });
  return { githubApp: slug ? { slug: slug.value, setBy: slug.setBy, setAt: slug.setAt } : null, tokens };
}

/**
 * Stores a pasted token as the actor: one of the config's setup tokens only. Storing sanoma-ops's
 * account token also mints the instance's own (`SANOMA_WAKEUP_TOKEN`) when none is stored, and a
 * new one for another account's, so going live can give the host it from the first apply, and the
 * wakeup's create registers it.
 */
export async function setSetupToken(app: AppContext, actor: Principal, { name, value }: SetCredentialRequest) {
  const names = setupTokens(app);
  if (!names.includes(name)) {
    const error = `${name} is not a setup token; they are ${names.join(", ")}`;
    throw new ApiError(400, {
      error,
      code: "invalid_input",
      issues: [{ path: ["name"], message: error, code: "custom" }],
    });
  }
  const { client } = app;
  const before = name === OPS_TOKEN ? (await client.secrets([OPS_TOKEN])).get(OPS_TOKEN)?.value : undefined;
  await client.setSecret(name, value, { by: actor.id });
  // Another account's: the instance token the old one registered would be refused (a 409).
  if (name === OPS_TOKEN) await mintWakeupToken(client, actor, before !== undefined && before !== value);
}

/**
 * Mints the instance's own token (`SANOMA_WAKEUP_TOKEN`) when it is not stored, or again when
 * `fresh`, for a new sanoma-ops account: storing the account's token does, and going live, when
 * it declares a wakeup.
 */
export async function mintWakeupToken(client: AppContext["client"], actor: Principal, fresh = false) {
  if (fresh || !(await client.secrets([WAKEUP_TOKEN])).has(WAKEUP_TOKEN)) {
    await client.setSecret(WAKEUP_TOKEN, mintInstanceToken(), { by: actor.id });
  }
}

/** The manifest the App is created from: its OAuth callback is the login's, its webhook this app's. */
export function githubManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    redirect_url: `${origin}${CALLBACK}`,
    callback_urls: [`${origin}/auth/github/callback`],
    // Off until the app has a route that receives them: GitHub would fail every delivery.
    hook_attributes: { url: `${origin}/webhooks/github`, active: false },
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
 * checks, which carries who asked: GitHub's redirect back does not bring the loopback login's
 * name, and the App's keys are stored as that person. The person names and creates the App on
 * GitHub's page. Nobody asking goes back to the connect page, which says so.
 */
export async function manifestPage(
  { app: { description }, actor: resolve }: ActorContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const org = url.searchParams.get("org")?.trim();
  if (org && !/^[\w-]+$/.test(org)) return toConnect("bad-org");
  const actor = await resolve();
  if (!actor) return toConnect("nobody");
  const state = randomBytes(16).toString("base64url");
  const payload = `${state}.${Buffer.from(actor.id).toString("base64url")}`;
  const to = new URL(
    org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  );
  to.searchParams.set("state", state);
  const manifest = JSON.stringify(githubManifest(url.origin, `Sanoma ${description.appName}`.slice(0, 34)));
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
      "set-cookie": cookie(request, STATE, `${payload}.${stateSigner().sign(payload)}`, STATE_PATH, 600),
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
  const [sent, who, signature] = (cookies(request)[STATE] ?? "").split(".");
  const payload = `${sent}.${who}`;
  if (!code || !state || !sent || !who || !signature || sent !== state || !stateSigner().verify(payload, signature)) {
    return toConnect("expired", request);
  }
  // Who started the flow, as the manifest page admitted them.
  const by = Buffer.from(who, "base64url").toString();
  try {
    const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "sanoma" },
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

/** Signs the state under a key derived from `SANOMA_SECRETS_KEY`, which storing the App's keys needs anyway. */
function stateSigner() {
  const secretsKey = process.env.SANOMA_SECRETS_KEY;
  if (!secretsKey) throw new Error("Connecting GitHub needs SANOMA_SECRETS_KEY, which encrypts the App's keys");
  return signer(secretsKey, "sanoma setup state");
}

// Connecting an existing repository or database: each is imported by its name or ref, declared
// in `resources/sanoma/infra.ts` from what was read, and bound to that file's declaration by an
// apply run that only binds. In a repository with a remote, the file goes on a branch of its own
// for a person to merge; without one (local), it is committed where the checkout is.

/** The branch the change waits on, in a repository with a remote. */
export const CONNECT_BRANCH = "setup/connect-existing";

/**
 * What each existing object is declared as: its export, its type, the constructors' import, the
 * fields copied from what the vendor holds (none vendor-owned or write-only), and those set here.
 */
const EXISTING = {
  repository: {
    name: "repo",
    vendor: "github",
    type: "repository",
    source: "@sanoma-ai/connector-github/resources",
    fields: ["name", "description", "visibility"],
    set: {},
  },
  // Supabase never reads the password back: declared generated, it is set by the next apply that
  // changes the project, not by this one, which only binds.
  project: {
    name: "store",
    vendor: "supabase",
    type: "project",
    source: "@sanoma-ai/connector-supabase/resources",
    fields: ["name", "organization_id", "region"],
    set: { database_password: secretOf("SUPABASE_DB_PASSWORD", { generate: true }) },
  },
} as const;

/**
 * Connects an existing GitHub repository and/or Supabase project: imports each through its
 * type's import, renders `INFRA` from what was read, commits it through the app's source
 * (on `CONNECT_BRANCH`, checked out, when the repository has a remote), then starts apply with
 * `bind` and `only` for those declarations, so the lockfile gets their bindings and nothing is
 * created. A 409 when the file is there already or the branch is; a 400 when a type has no
 * connector here, or the vendor has no such object.
 *
 * The imports run here, before the file they declare exists, so outside any run: the policy and
 * the ledger see apply's own import of each, by its binding, when it binds them.
 */
export function connectExisting(
  app: AppContext,
  actor: Principal,
  request: ConnectExistingRequest,
): Promise<ConnectExistingResponse> {
  const done = connecting.then(() => connectNow(app, actor, request));
  connecting = done.catch(() => undefined);
  return done;
}

/** The connect under way, if any: one at a time, so two never both find no file and write it. */
let connecting: Promise<unknown> = Promise.resolve();

async function connectNow(
  { client, resolved, source }: AppContext,
  actor: Principal,
  request: ConnectExistingRequest,
): Promise<ConnectExistingResponse> {
  const { root } = resolved;
  if (root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  const path = join(root, INFRA);
  if (existsSync(path)) {
    throw new ApiError(409, { error: `${INFRA} is there already: declare what to connect in it instead` });
  }
  const wanted = (["repository", "project"] as const).flatMap((what) => {
    const given = request[what];
    return given ? [{ ...EXISTING[what], given }] : [];
  });
  const states = await Promise.all(
    wanted.map(({ vendor, type, given }) => imported(resolved, `${vendor}.${type}`, given.split("/").at(-1)!, given)),
  );
  const exports = [];
  const bind: Record<string, string> = {};
  for (const [i, { given, ...at }] of wanted.entries()) {
    const state = states[i]!;
    const owner = given.includes("/") ? given.slice(0, given.indexOf("/")) : undefined;
    // The connector reads one owner's repositories (`GITHUB_OWNER`, else the token's user).
    if (owner && String(state.full_name).toLowerCase() !== given.toLowerCase()) {
      throw new ApiError(400, {
        error: `The GitHub connector reads ${String(state.full_name)}, not ${given}: set GITHUB_OWNER to ${owner}`,
      });
    }
    const read = at.fields.flatMap((f) => (state[f] == null || state[f] === "" ? [] : [[f, state[f] as DataValue]]));
    exports.push({ ...at, desired: { ...Object.fromEntries(read), ...at.set } });
    bind[`${INFRA}#${at.name}`] = resolved.types.get(`${at.vendor}.${at.type}`)!.bindingId(state);
  }
  const imports = wanted.map(({ vendor, source: from }) => ({ source: from, imported: vendor, local: vendor }));
  const rendered = await renderDataFile({ imports, exports }, formatOptions(root));
  const text = request.project ? `${PASSWORD_NOTE.map((line) => `// ${line}\n`).join("")}${rendered}` : rendered;

  const git = source && (await gitAt(source.root));
  const branch = git && (await git("remote")) ? CONNECT_BRANCH : undefined;
  if (branch) {
    try {
      await git!("switch", "--quiet", "-c", branch);
    } catch (err) {
      throw new ApiError(409, { error: `Could not start the branch ${branch}: ${errorMessage(err)}` });
    }
  }
  const names = wanted.map((w) => `${w.vendor} ${w.given}`).join(" and ");
  let commit: { revision: string } | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    commit = await source?.commit({
      paths: [relative(source.root, path)],
      message: `Connect ${names}`,
      author: actor.id,
    });
  } catch (err) {
    // Left as it was: no file, and back on the branch it started from, so connecting again works.
    await rm(path, { force: true });
    if (branch) await git!("switch", "--quiet", "-").then(() => git!("branch", "-D", branch));
    throw new ApiError(500, { error: `Could not commit ${INFRA}: ${errorMessage(err)}` });
  }
  const diff = branch && commit ? await git!("show", "--format=", commit.revision) : undefined;
  const runId = await client.apply({ only: Object.keys(bind), bind }, { startedBy: actor }).catch((err: unknown) => {
    throw new ApiError(500, {
      error: `Committed ${INFRA}, but could not start the apply that binds it: ${errorMessage(err)}. Apply it from Resources.`,
    });
  });
  return { file: INFRA, text, runId, ...commit, ...(branch && { branch }), ...(diff && { diff }) };
}

/**
 * The state of the object `id` names (`given` by the person), read through its type's import; a 400 when the config
 * has no driver for it, or the vendor has no such object, or the read fails.
 */
async function imported(resolved: AppContext["resolved"], type: string, id: string, given = id) {
  const opId = `${type}.import`;
  const driver = resolved.drivers.get(opId);
  if (!driver) {
    const vendor = type.slice(0, type.indexOf("."));
    throw new ApiError(400, {
      error: `Connecting a ${type} needs @sanoma-ai/connector-${vendor} among the config's connectors`,
    });
  }
  // A read: it needs no secret, and nothing it is given names one.
  const call = { idempotencyKey: randomUUID(), runId: "setup", opId, attempt: 1, secrets: memorySecrets() };
  let found: { gone: boolean; state?: Record<string, unknown> };
  try {
    found = (await driver({ id }, call)) as typeof found;
  } catch (err) {
    throw new ApiError(400, { error: `Could not read the ${type} ${given}: ${errorMessage(err)}` });
  }
  if (found.gone || !found.state) {
    // A repository is read by its name, among the connector's owner's (`GITHUB_OWNER`, else the token's user).
    const owner =
      given === id ? "" : " among the GitHub connector's owner's repositories: set GITHUB_OWNER to its owner";
    throw new ApiError(400, { error: `There is no ${type} ${given} to connect${owner}` });
  }
  return found.state;
}

const execGit = promisify(execFile);

/** Git in `root`, when it is a git checkout: each call's output, trimmed. */
async function gitAt(root: string) {
  const run = async (...args: string[]) =>
    (await execGit("git", args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  return (await run("rev-parse", "--is-inside-work-tree").catch(() => "")) === "true" ? run : undefined;
}
