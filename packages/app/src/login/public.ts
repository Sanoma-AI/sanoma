import type { LoginHalf, Principal, Tokens } from "@sanoma-ai/workflows";
import { ANONYMOUS_PRINCIPAL, visitorPrincipal } from "@sanoma-ai/workflows/shared";
import type { AdmittingLogin } from "../context.ts";

// A public site's front door: on the site's own host it stands where the staff login stands on
// the app's, and never reads the staff login's cookie or header.

/** What a public site answers: a page's GET and HEAD, and the POST of a server function or a sign-in. */
const METHODS = new Set(["GET", "HEAD", "POST"]);

/** A subject a visitor's id can hold: no whitespace (`visitorPrincipal`). */
const SUBJECT = /^\S+$/;

const notFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** An api token, `Authorization: Bearer sca_…`: the request's, or undefined. */
export const bearerOf = (request: Request) =>
  /^Bearer (sca_\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];

/**
 * The login on a public site's host (`site:<name>`, so the page shows who it says): a caller with
 * an api token (`Authorization: Bearer sca_…`, `tokens`) as `token:<id>`, with the token's groups;
 * else the visitor the site's login half verifies (`visitorPrincipal`, in `visitors`, with their
 * `email` and `github` when the half verified them), else `anonymous`; never nobody. Its `handle` answers a
 * token it does not know, or one revoked, with a 401, sends `/auth/<login>/*` to the half and
 * answers any other `/auth/*` with a 404, and any method but GET, HEAD and POST with a 405.
 * `half` is being made while the app starts: a request that comes first waits for it.
 */
export function publicFront(
  site: { name: string; login?: string },
  half?: Promise<LoginHalf>,
  tokens?: Tokens["resolve"],
): AdmittingLogin {
  const { login } = site;
  const own = (pathname: string) =>
    login !== undefined && (pathname === `/auth/${login}` || pathname.startsWith(`/auth/${login}/`));
  /** The token's principal, by request: `handle` reads it, then the server's `resolveActor`. */
  const byToken = new WeakMap<Request, Promise<Principal | undefined>>();
  const tokenOf = (request: Request, bearer: string) => {
    let found = byToken.get(request);
    if (!found) byToken.set(request, (found = (async () => (await tokens?.(bearer))?.principal)()));
    return found;
  };
  const front: AdmittingLogin = {
    name: `site:${site.name}`,
    check() {},
    async resolveActor(request) {
      const bearer = bearerOf(request);
      if (bearer !== undefined) return tokenOf(request, bearer);
      const verified = half && login !== undefined ? await (await half).verify(request) : null;
      if (!verified || !SUBJECT.test(verified.subject)) return ANONYMOUS_PRINCIPAL;
      // What a provider verified rides along (`LoginIdentity`); admission keeps it as a run's `ctx.startedBy`.
      const visitor: Principal = visitorPrincipal(login!, verified.subject);
      if (verified.email) visitor.email = verified.email;
      if (verified.github) visitor.github = verified.github;
      return visitor;
    },
    async handle(request) {
      if (!METHODS.has(request.method)) {
        const allow = [...METHODS].join(", ");
        return new Response(null, { status: 405, headers: { allow, "cache-control": "no-store" } });
      }
      const bearer = bearerOf(request);
      if (bearer !== undefined && !(await tokenOf(request, bearer))) {
        return Response.json(
          { error: "That api token is not one this company minted, or it was revoked" },
          { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
        );
      }
      const { pathname } = new URL(request.url);
      if (pathname !== "/auth" && !pathname.startsWith("/auth/")) return undefined;
      return (half && own(pathname) ? await (await half).handle(request) : undefined) ?? notFound();
    },
  };
  // Its sign-out route, once the half says it; the app reports a half that fails as it starts.
  half?.then(
    ({ signOut }) => void (signOut !== undefined && (front.signOut = signOut)),
    () => {},
  );
  return front;
}
