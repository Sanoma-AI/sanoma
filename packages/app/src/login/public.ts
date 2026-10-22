import type { LoginHalf } from "@sanoma-ai/workflows";
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

/**
 * The login on a public site's host (`site:<name>`, so the page shows who it says): the visitor
 * the site's login half verifies (`visitorPrincipal`, in `visitors`), else `anonymous`; never
 * nobody. Its `handle` sends `/auth/<login>/*` to the half and answers any other `/auth/*` with a
 * 404, and any method but GET, HEAD and POST with a 405. `half` is being made while the app
 * starts: a request that comes first waits for it.
 */
export function publicFront(site: { name: string; login?: string }, half?: Promise<LoginHalf>): AdmittingLogin {
  const { login } = site;
  const own = (pathname: string) =>
    login !== undefined && (pathname === `/auth/${login}` || pathname.startsWith(`/auth/${login}/`));
  const front: AdmittingLogin = {
    name: `site:${site.name}`,
    check() {},
    async resolveActor(request) {
      const verified = half && login !== undefined ? await (await half).verify(request) : null;
      return verified && SUBJECT.test(verified.subject)
        ? visitorPrincipal(login!, verified.subject)
        : ANONYMOUS_PRINCIPAL;
    },
    async handle(request) {
      if (!METHODS.has(request.method)) {
        const allow = [...METHODS].join(", ");
        return new Response(null, { status: 405, headers: { allow, "cache-control": "no-store" } });
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
