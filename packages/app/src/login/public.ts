import {
  errorMessage,
  type LoginHalf,
  type Principal,
  type ResolvedConfig,
  type SanomaClient,
  type SocialClients,
  type Tokens,
} from "@sanoma-ai/workflows";
import type { SiteEntry } from "@sanoma-ai/workflows/describe";
import { ANONYMOUS_PRINCIPAL, siteDir, visitorPrincipal } from "@sanoma-ai/workflows/shared";
import type { AdmittingLogin } from "../context.ts";
import { secretValues } from "../server/secrets.ts";
import { loginKey } from "./keys.ts";
import { sendLoginCode } from "./staff.ts";

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
 * A public site's login half (`ConnectorSetup.login` of the connector `site.login` names), given
 * what the app has: the client's pool, the key derived for that login, the stored secrets, the
 * site's `origins`, the sender when the config names one, and the company's own OAuth clients. It
 * opens nothing; what fails here is the key or the config, and the site is then served on no host.
 */
export async function siteLogin(
  resolved: ResolvedConfig,
  client: SanomaClient,
  { login }: Pick<SiteEntry, "login">,
  origins: readonly string[],
  social: SocialClients | undefined,
): Promise<LoginHalf> {
  return resolved.logins.get(login!)!({
    database: () => client.pool(),
    key: loginKey(login!),
    secrets: secretValues(client),
    origins,
    ...(resolved.login && { sendCode: (email, code) => sendLoginCode(client, email, code) }),
    social,
  });
}

/**
 * Settles once `site`'s login `half` is made: one that fails (its key, its config) is logged, with
 * the adapter's `prefix`, and its site taken off `sites`, so it is served on no host (503).
 */
export async function servedOnceMade(
  sites: Map<string, AdmittingLogin>,
  site: Pick<SiteEntry, "name" | "login">,
  half: Promise<LoginHalf>,
  prefix: string,
): Promise<void> {
  await half.catch((err: unknown) => {
    sites.delete(site.name);
    console.error(
      `${prefix}: ${siteDir(site.name)}'s login (${site.login}) could not start, so the site is not served: ${errorMessage(err)}`,
    );
  });
}

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
