// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { errorMessage, type Principal, type SanomaClient } from "sanoma/workflows";
import { slugged } from "sanoma/workflows/shared";
import { ApiError, INFRA, type SanomaSignIn } from "../api.ts";
import type { AppContext } from "../context.ts";
import { companyOf } from "../lib/names.ts";
import { escapeHtml, smallPage } from "../login/page.ts";

// Signing in to Sanoma from Hosting, on this computer: the company's Cloud token brought back from
// www.sanoma.work by a one-time code (RFC 8252's native-app shape, with PKCE). The app opens
// `/connect` in the default browser with a random state and the verifier's S256 challenge; there
// the person signs in and allows it, and the browser comes back to this app's
// `/hosting/sanoma/callback` with the code and the state. The callback lands in the default
// browser, without the app window's cookies, so the state and the verifier are kept here, in the
// company's secrets, never in a URL or a cookie; the callback redeems the code with the verifier
// (`POST /api/token/redeem` on the Cloud) and stores the token. Nothing here logs a code, a
// verifier or a token, nor sends one to a page.

/** The secret the Cloud token is stored under, which the Sanoma Cloud connector's driver reads. */
export const CLOUD_TOKEN = "SANOMA_CLOUD_TOKEN";
/** What a Cloud token looks like: an api token of sanoma-ops's (the driver's own check). */
export const CLOUD_TOKEN_PATTERN = /^sca_[\w-]+$/;
/** The Cloud's api: the variable the driver declares, as stored here, else www.sanoma.work, the driver's default. */
const CLOUD_URL = "SANOMA_CLOUD_URL";
const DEFAULT_URL = "https://www.sanoma.work";

/** Where a sign-in is kept while the person is at the Cloud: its state, verifier, expiry and who started it. */
const SIGN_IN = "SANOMA_CLOUD_SIGN_IN";
/** How long the person has to sign in at the Cloud and allow it. */
const SIGN_IN_MS = 10 * 60_000;
/** Where the Cloud sends the browser back. */
export const SIGN_IN_CALLBACK = "/hosting/sanoma/callback";

/** A sign-in being made, as kept in `SIGN_IN`. */
interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
  by: string;
}

/** The Cloud's api, where `/connect` and `/api/token/redeem` answer. */
async function cloudUrlOf(client: SanomaClient): Promise<string> {
  return (await client.secrets([CLOUD_URL])).get(CLOUD_URL)?.value ?? DEFAULT_URL;
}

/** The sign-in being made, unless none is or it expired. */
async function pendingOf(client: SanomaClient): Promise<Pending | undefined> {
  const stored = (await client.secrets([SIGN_IN])).get(SIGN_IN)?.value;
  if (!stored) return undefined;
  try {
    const pending = JSON.parse(stored) as Pending;
    return pending.expiresAt > Date.now() ? pending : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The company's slug at Sanoma Cloud, its address `<slug>.sanoma.work`: the name `infra.ts`'s host
 * declares, else one made of the company's name.
 */
export const slugOf = ({ snapshot }: Pick<AppContext, "snapshot">) => {
  const declared = snapshot.description.resources.find((r) => r.id === `${INFRA}#host`)?.desired.name;
  return typeof declared === "string" ? declared : slugged(snapshot.description.name).slice(0, 40).replace(/-+$/, "");
};

/**
 * Starts signing in to Sanoma, on this computer only: a new state and verifier kept here (any
 * earlier sign-in's dropped), and the Cloud's `/connect` page to open in the browser, which
 * carries the state, the verifier's S256 challenge, where to come back to (this app's own origin,
 * as a loopback address), and the company's name and the repository's (its address).
 */
export async function startSanomaSignIn(
  app: AppContext,
  actor: Principal,
  origin: string,
  { address }: { address?: string } = {},
): Promise<{ url: string }> {
  if (app.place !== "this-computer") {
    throw new ApiError(409, {
      error: "Signing in to Sanoma is for the app on a computer: a hosted company has its token",
    });
  }
  const { client } = app;
  const verifier = generateRandomCodeVerifier();
  const pending: Pending = {
    state: randomBytes(32).toString("base64url"),
    verifier,
    expiresAt: Date.now() + SIGN_IN_MS,
    by: actor.id,
  };
  await client.setSecret(SIGN_IN, JSON.stringify(pending), { by: actor.id });
  const back = new URL(SIGN_IN_CALLBACK, origin);
  // A loopback address, as RFC 8252 asks, which the Cloud allows: `localhost` may name another.
  if (back.hostname === "localhost") back.hostname = "127.0.0.1";
  const slug = address ?? slugOf(app);
  const url = new URL("/connect", await cloudUrlOf(client));
  url.searchParams.set("state", pending.state);
  url.searchParams.set("challenge", await calculatePKCECodeChallenge(verifier));
  url.searchParams.set("challenge_method", "S256");
  url.searchParams.set("return", back.href);
  url.searchParams.set("company", app.snapshot.description.name);
  url.searchParams.set("repository", slug);
  return { url: url.href };
}

/** Whether a Cloud token is stored (and where from), and whether a sign-in is being made: never a value. */
export async function sanomaSignIn({ client }: AppContext): Promise<SanomaSignIn> {
  const [found, pending] = await Promise.all([client.secrets([CLOUD_TOKEN]), pendingOf(client)]);
  const token = found.get(CLOUD_TOKEN);
  const signedIn = token !== undefined && CLOUD_TOKEN_PATTERN.test(token.value);
  return {
    signedIn,
    pending: pending !== undefined,
    ...(token && { source: token.source, ...(token.setBy && { setBy: token.setBy, setAt: token.setAt }) }),
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Whether two strings are the same, in a time that does not say how much of them is. */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** How long the Cloud has to answer the redeem. */
const REDEEM_MS = 15_000;

/**
 * `GET /hosting/sanoma/callback?code&state`: where the Cloud sends the browser back. The sign-in
 * kept here is dropped first (a code works once, and a second request finds none), its state
 * checked against the one sent (in constant time) and its expiry; the code is then redeemed with
 * the verifier at the Cloud, the answer taken only as a Cloud token, and stored as
 * `SANOMA_CLOUD_TOKEN` as the person who started it. A small page says how it went, never cached.
 */
export async function sanomaCallback(app: AppContext, request: Request): Promise<Response> {
  const { client } = app;
  const page = (status: number, title: string, text: string) =>
    smallPage(status, title, `<h1>${escapeHtml(title)}</h1><p>${text}</p>`, {
      company: companyOf(app.snapshot.description.name),
      ...(app.stylesheet && { stylesheet: app.stylesheet }),
    });
  const again = "Go back to the app and sign in to Sanoma again.";
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const pending = await pendingOf(client);
  if (!pending || !state || !same(state, pending.state)) {
    return page(400, "This sign-in is not the app's", `It expired, was used, or another started since. ${again}`);
  }
  await client.clearSecret(SIGN_IN, { by: pending.by });
  if (params.get("error")) return page(400, "Signing in was cancelled", again);
  if (!code || code.length > 256) return page(400, "Sanoma sent no code", again);
  let res: Response;
  try {
    res = await fetch(new URL("/api/token/redeem", await cloudUrlOf(client)), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, verifier: pending.verifier }),
      // A redirect is no answer of the Cloud's, and would carry the code elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(REDEEM_MS),
    });
  } catch (err) {
    console.error(`sanoma app: Sanoma could not be reached to finish signing in: ${errorMessage(err)}`);
    return page(502, "Sanoma could not be reached", again);
  }
  if (res.status === 410) return page(410, "This sign-in has expired", again);
  const token = res.ok
    ? ((await res.json().catch(() => undefined)) as { token?: unknown } | undefined)?.token
    : undefined;
  if (typeof token !== "string" || !CLOUD_TOKEN_PATTERN.test(token)) {
    console.error(`sanoma app: Sanoma answered ${res.status} to the sign-in, with no Cloud token`);
    return page(502, "Sanoma did not answer with a Cloud token", again);
  }
  try {
    await client.setSecret(CLOUD_TOKEN, token, { by: pending.by });
  } catch (err) {
    if ((err as { code?: unknown }).code === "read_only") {
      return page(
        409,
        "The Cloud token is set elsewhere",
        `<code>${CLOUD_TOKEN}</code> is set in this company's <code>.env</code> or environment, which the app cannot change. Remove it there, then sign in again.`,
      );
    }
    console.error(`sanoma app: the Cloud token was not stored: ${errorMessage(err)}`);
    return page(500, "The Cloud token was not stored", again);
  }
  return page(200, "Signed in to Sanoma", "Go back to the app: it goes live from there.");
}
