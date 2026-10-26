import type { Principal } from "@sanoma-ai/workflows";
import { parse } from "cookie-es";
import { isLoopback } from "@sanoma-ai/workflows/shared";
import { ACTOR_COOKIE, ACTOR_HEADER, type Place } from "./api.ts";
import type { LoginProvider } from "./context.ts";

// The loopback login, and the Host names a loopback-only app answers to. Which addresses count
// as this machine is `isLoopback` in `@sanoma-ai/workflows/shared`, for what startApp listens on
// and the Host names it then answers to alike, so the two can never disagree.

/** The loopback login's name. */
export const LOOPBACK = "loopback";

/**
 * The default login: none. Whoever reaches the app acts as the name the page sends
 * (`actorFromHeader`), or, with no header, the one it keeps in its cookie (`ACTOR_COOKIE`), which
 * a page's server render has; so it refuses to listen anywhere but this machine. Even there, a page
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
    resolveActor: (request) => actorFromHeader(request) ?? actorFromCookie(request),
    handle(request) {
      const host = request.headers.get("host") ?? "";
      const name = hostName(host);
      // `*.localhost` is this machine too (RFC 6761): a public site's host, `<name>.localhost`.
      return isLoopback(name) || name.endsWith(".localhost") ? undefined : refuseHost(host);
    },
  };
}

/** The URI-encoded name in the `x-sanoma-actor` header, as `{ id }`: whom the loopback login takes first. */
export function actorFromHeader(request: Request): Principal | undefined {
  let id = request.headers.get(ACTOR_HEADER) ?? "";
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not URI-encoded: take it as sent.
  }
  return named(id);
}

/** The name in the page's `sanoma_actor` cookie (decoded as it is parsed), as `{ id }`: whom the loopback login takes without a header. */
export const actorFromCookie = (request: Request): Principal | undefined =>
  named(parse(request.headers.get("cookie") ?? "")[ACTOR_COOKIE] ?? "");

const named = (name: string): Principal | undefined => (name.trim() ? { id: name.trim() } : undefined);

/** The host name in a Host header (`name`, `name:port`, `[v6]:port`), lowercased. */
export function hostName(header: string): string {
  const name = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.replace(/:\d*$/, "");
  return name.toLowerCase();
}

/**
 * The host of the database at `databaseUrl`, lowercased: the URL's, else its `?host=` (a Unix
 * socket's directory, or a server's name); none when it gives neither (the default socket).
 */
export function databaseHost(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return (url.hostname || url.searchParams.get("host") || "").toLowerCase();
}

/**
 * Where an instance on the database at `databaseUrl` is: this computer when the database's host is
 * a loopback name or a socket (none, or a path), else live.
 */
export const placeOf = (databaseUrl: string): Place => {
  const host = databaseHost(databaseUrl);
  return host === "" || host.startsWith("/") || isLoopback(host) ? "this-computer" : "live";
};

/** The 403 for a request that reached a loopback-only app under some other name (DNS rebinding). */
export function refuseHost(host: string): Response {
  return Response.json(
    { error: `This app answers to localhost only, not ${host || "a request with no Host"}` },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
