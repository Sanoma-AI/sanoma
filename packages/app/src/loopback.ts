import type { Principal } from "@sanoma-ai/workflows";
import { isLoopback } from "@sanoma-ai/workflows/shared";
import { ACTOR_HEADER } from "./api.ts";
import type { LoginProvider } from "./context.ts";

// The loopback login, and the Host names a loopback-only app answers to. Which addresses count
// as this machine is `isLoopback` in `@sanoma-ai/workflows/shared`, for what startApp listens on
// and the Host names it then answers to alike, so the two can never disagree.

/** The loopback login's name. */
export const LOOPBACK = "loopback";

/**
 * The default login: none. Whoever reaches the app acts as the name the page sends
 * (`actorFromHeader`), so it refuses to listen anywhere but this machine. Even there, a page
 * elsewhere could reach the app by pointing its own host name at 127.0.0.1 (DNS rebinding); its
 * requests then carry that name in Host, so any request not addressed to a loopback name is refused.
 */
export function loopbackLogin(): LoginProvider {
  return {
    name: LOOPBACK,
    check(listenHost) {
      if (isLoopback(listenHost)) return;
      throw new Error(
        `The app has no login, so it listens on this machine only, not ${listenHost}: ` +
          "anyone who could reach it would act as any name. Pass a login provider (githubLogin) to listen there.",
      );
    },
    resolveActor: actorFromHeader,
    handle(request) {
      const host = request.headers.get("host") ?? "";
      return isLoopback(hostName(host)) ? undefined : refuseHost(host);
    },
  };
}

/** The loopback login's `resolveActor`: the URI-encoded name in the `x-sanoma-actor` header, as `{ id }`. */
export function actorFromHeader(request: Request): Principal | undefined {
  let id = request.headers.get(ACTOR_HEADER) ?? "";
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not URI-encoded: take it as sent.
  }
  id = id.trim();
  return id ? { id } : undefined;
}

/** The host name in a Host header (`name`, `name:port`, `[v6]:port`), lowercased. */
export function hostName(header: string): string {
  const name = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.replace(/:\d*$/, "");
  return name.toLowerCase();
}

/** The 403 for a request that reached a loopback-only app under some other name (DNS rebinding). */
export function refuseHost(host: string): Response {
  return Response.json(
    { error: `This app answers to localhost only, not ${host || "a request with no Host"}` },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
