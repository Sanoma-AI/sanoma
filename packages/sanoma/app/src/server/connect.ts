// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createHash } from "node:crypto";
import { type CallbackError, errorCode, type Principal, requestOrigin } from "sanoma/workflows";
import { connectionCallbackPath } from "sanoma/workflows/shared";
import type { AuthorizeConnectionRequest, CallbackErrorReason } from "../api.ts";
import type { AppContext } from "../context.ts";
import { actorCookie, cookie, cookies } from "../login/keys.ts";

// OAuth consent for a named connection, the app's half: Connect starts an attempt through the
// client's secure intake (`authorizeConnection`) and binds it to this browser with a signed
// cookie; the provider sends the person back to `/connect/<vendor>/callback`, which checks the
// cookie and the state, seals the code into the attempt and starts the `connect` run, then goes
// back to the connector page with the attempt's id, never the code or state, in the URL. The
// callback logs no query string. Postgres and the signing key only, as the Worker serves it.

/**
 * The cookie that binds an attempt to the browser that started it, sent only to the callbacks:
 * one per attempt, named by its state's hash, so two attempts under way in one browser keep their
 * own and a callback clears only its own.
 */
const attemptCookieName = (state: string) =>
  `sanoma_connect_${createHash("sha256").update(state).digest("base64url").slice(0, 16)}`;
const ATTEMPT_PATH = "/connect";

const attemptCookie = () => actorCookie("sanoma connection attempt");

/**
 * Starts consent for the actor's connection: the client's intake with the app's own callback as
 * the redirect URI. Returns the consent URL and the attempt's id for the page, and the cookie
 * line that binds the attempt to this browser (the loopback login's actor is a header a
 * redirect does not carry), for the server function to set.
 */
export async function authorizeConnection(
  { client }: AppContext,
  actor: Principal,
  { target, requestId, client: application }: AuthorizeConnectionRequest,
  request: Request,
): Promise<{ attempt: string; url: string; expiresAt: number; connection: string; cookie: string }> {
  const vendor = "connection" in target ? target.connection.vendor : target.rule.split("/")[0]!;
  const started = await client.authorizeConnection(target, {
    actor,
    id: requestId,
    redirectUri: `${requestOrigin(request)}${connectionCallbackPath(vendor)}`,
    ...(application && { client: application }),
  });
  const maxAge = Math.ceil((started.expiresAt - Date.now()) / 1000);
  const sealed = attemptCookie().seal(started.attempt, actor.id);
  const name = attemptCookieName(new URL(started.url).searchParams.get("state")!);
  return { ...started, cookie: cookie(request, name, sealed, ATTEMPT_PATH, maxAge) };
}

/**
 * `GET /connect/<vendor>/callback?code&state` (or `?error&state`): the attempt this browser's
 * cookie for the state names, as the person who started it, received by the client, which starts the
 * `connect` run. Back to the connector page with `?attempt=` to follow, or `?error=` with one
 * of `CALLBACK_ERRORS` (`api.ts`); the cookie cleared either way.
 */
export async function connectionCallback({ client }: AppContext, request: Request, vendor: string): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const name = state ? attemptCookieName(state) : undefined;
  const started = name ? attemptCookie().open(cookies(request)[name]) : undefined;
  let to: URLSearchParams;
  if (!started) {
    to = new URLSearchParams({ error: "mismatch" satisfies CallbackErrorReason });
  } else {
    try {
      const attempt = started.value;
      const { connection } = await client.receiveConnection(vendor, attempt, url.searchParams, {
        actor: started.actor,
      });
      to = new URLSearchParams({ connection, attempt });
    } catch (error) {
      // Read by name: two copies of the runtime may load. Never log the error's message or the
      // request's URL, either of which may carry the code.
      const refused =
        (error as Partial<CallbackError>)?.name === "CallbackError" ? (error as CallbackError).reason : undefined;
      if (!refused) console.error("sanoma app: an OAuth callback failed:", errorCode(error) ?? (error as Error)?.name);
      to = new URLSearchParams({ error: refused ?? ("failed" satisfies CallbackErrorReason) });
    }
  }
  const headers = new Headers({
    location: `/connectors/${encodeURIComponent(vendor)}?${to}`,
    "cache-control": "no-store",
  });
  if (name) headers.append("set-cookie", cookie(request, name, "", ATTEMPT_PATH, 0));
  return new Response(null, { status: 303, headers });
}
