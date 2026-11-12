// The app: one fetch handler over the company's snapshot and its client, the same on Node (the
// Node adapter, `startApp`) and on Cloudflare's workerd (the Worker's bundle, `worker/main.ts`).
// It keeps nothing across requests but what it was built with, reaches Postgres through its
// client and nothing else of the company's, and reads no file: a static file and a prerendered
// page are the host's (`files`).
import { type ResolvedConfig, requestOrigin, type SanomaClient } from "sanoma/workflows";
import type { ConfigDescription, SiteEntry } from "sanoma/workflows/describe";
import { siteDir } from "sanoma/workflows/shared";
import type { AdmittingLogin, AppContext, RequestContext, ServerEntry } from "./context.ts";
import { hostName, placeOf } from "./loopback.ts";
import { seoFile } from "./seo.ts";
import { siteHost, sitePath } from "./site-path.ts";
import type { AppSnapshot } from "./snapshot.ts";
import { redeemToken } from "./server/token-redeem.ts";
import { plain, remoteWebhook } from "./server/webhooks.ts";

/** A machine route, such as the wakeup's `/wake`: answered ahead of the public sites and the login (`AppHandlerOptions.ingress`). */
export interface IngressRoute {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** The whole path, from `/`, without a query: matched exactly, unless `prefix`. */
  path: string;
  /**
   * Also every path under `path` (`/wakeup` answers `/wakeup/instances/…`), for a route that
   * matches what follows itself. A route at the exact path comes first, then the longest prefix.
   */
  prefix?: boolean;
  handle(request: Request): Promise<Response>;
}

export interface AppHandlerOptions {
  resolved: ResolvedConfig;
  /** The company as this request reads it: the Node adapter's, made again once a file changed, or the bundle's own. */
  snapshot: () => AppSnapshot | Promise<AppSnapshot>;
  client: SanomaClient;
  /** The staff login, admitting only a declared person (`admitting`). */
  login: AdmittingLogin;
  /**
   * Each public site served, by name, with its front door (`publicFront`): a public site missing
   * here (its `site.ts` has a problem, or its login could not start) answers 503 on its hosts.
   * Read on each request, so a host may take one out once it knows its login failed.
   */
  sites: ReadonlyMap<string, AdmittingLogin>;
  /**
   * A public site's domain, by site name (`www: "sanoma.example"`): the site is served at the root
   * of that host, as at `<name>.localhost`. One naming a site that is missing or not public is
   * warned about and not served.
   */
  domains?: Readonly<Record<string, string>>;
  /**
   * Machine routes, answered right after `/healthz` and ahead of the public sites and the login,
   * at any host name: a request whose path is exactly `path` is answered by `handle`, or with 405
   * when `method` is given and the request's is another. One route per path, never `/healthz`.
   * Nothing checks who is asking, so each checks its own token; never give one a page's path.
   * Besides these, the app answers `POST /webhooks/<vendor>` for each connector's remote half that
   * reads webhooks (`remoteWebhook`), and `POST /api/token/redeem` (`redeemToken`).
   */
  ingress?: readonly IngressRoute[];
  /** Start's server entry: the pages and the server functions. */
  entry: ServerEntry;
  /**
   * What the host answers itself, after the login let the request through and before Start: a
   * built file, a site's public file among them at `/sites/<key>/<path>`. On a public site's host,
   * `site`, its own public files at the root (`publicPath`) and no other site's. Undefined for a
   * request it has nothing for.
   */
  files?: (request: Request, site?: string) => Promise<Response | undefined>;
  /** The built kit's stylesheet's path (`AppContext.stylesheet`). */
  stylesheet?: string;
}

export interface AppHandler {
  fetch(request: Request): Promise<Response>;
  /** The context the app's staff login opens with (`LoginProvider.open`): its `snapshot` the latest a request read. */
  context: AppContext;
  /** Each public site's hosts, by host name: `<name>.localhost` and its domain. */
  hosts: ReadonlyMap<string, SiteEntry>;
  /** Each public site's domain, by site name, as `hosts` has it. */
  domains: ReadonlyMap<string, string>;
}

/**
 * Makes the app's handler: `/healthz`, the machine routes, the webhooks and the token's redeem,
 * then a public site's host (its robots.txt and sitemap, its front door, then its pages and its
 * `api`), then the staff login, the host's files and the app's pages and server functions. The
 * public sites' hosts are read from `first`, the snapshot the host starts with.
 */
export function appHandler(options: AppHandlerOptions, first: AppSnapshot): AppHandler {
  const { resolved, client, login } = options;
  const ingressAt = ingressOf([
    ...(options.ingress ?? []),
    // A git host's webhooks, on every host: verified here, followed by the worker, which has the checkout.
    ...[...resolved.remotes]
      .filter(([, half]) => half.webhook)
      .map(([vendor]): IngressRoute => ({
        method: "POST",
        path: `/webhooks/${vendor}`,
        handle: async (request) => remoteWebhook(await contextOf(), vendor, request),
      })),
    // A handed-off token, for its one-time code and verifier alone (`sanoma.token.handoff`).
    { method: "POST", path: "/api/token/redeem", handle: (request) => redeemToken(client, request) },
  ]);
  const hosts = publicHosts(first.description, options.domains ?? {});
  const domains = new Map([...hosts.values()].flatMap((site) => (site.domain ? [[site.name, site.domain]] : [])));
  /** The snapshot with each public site's domain on its entry, as `publicHosts` set it. */
  const withDomains = new WeakMap<AppSnapshot, AppSnapshot>();
  const domained = (snapshot: AppSnapshot) => {
    let found = withDomains.get(snapshot);
    if (!found) {
      const sites = snapshot.description.sites.map((site) =>
        domains.has(site.name) ? { ...site, domain: domains.get(site.name)! } : site,
      );
      found = domains.size ? { ...snapshot, description: { ...snapshot.description, sites } } : snapshot;
      withDomains.set(snapshot, found);
    }
    return found;
  };
  let latest = domained(first);
  const shared = {
    resolved,
    place: placeOf(resolved.databaseUrl),
    client,
    ...(options.stylesheet && { stylesheet: options.stylesheet }),
  };
  const context: AppContext = {
    ...shared,
    get snapshot() {
      return latest;
    },
    login,
  };
  /** This request's context: the snapshot as it is now. */
  const contextOf = async (): Promise<AppContext> => {
    latest = domained(await options.snapshot());
    return { ...shared, snapshot: latest, login };
  };

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A host's probe, before the login: it says the app answers, and nothing else.
    if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : "ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    // A machine route, before the login too: it checks its own token.
    const route = ingressAt(url.pathname);
    if (route?.method !== undefined && route.method !== request.method) {
      return new Response(`${url.pathname} answers ${route.method} only\n`, {
        status: 405,
        headers: { allow: route.method, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (route) return route.handle(request);
    // A public site's host, ahead of the staff login, which it never reaches: the site's front door.
    const asked = hostName(url.host);
    const entry = hosts.get(asked);
    if (entry !== undefined) {
      const front = options.sites.get(entry.name);
      if (!front) {
        return plain(
          503,
          "This site is not served: its site.ts or its login has a problem, which the app's log names.\n",
        );
      }
      // A page's path on the app's host (`/sites/<name>/x`, a link copied from there) is its path
      // here, at the root: a GET or HEAD goes there, never to `//…`, which a browser reads as a host.
      const rooted = sitePath(entry.name, url.pathname);
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        rooted !== url.pathname &&
        !rooted.startsWith("//")
      )
        return new Response(null, { status: 308, headers: { location: `${rooted}${url.search}` } });
      // Its URLs are at its domain, when it has one; only there may a crawler index it.
      const origin = entry.domain ? `https://${entry.domain}` : requestOrigin(request);
      // The sitemap lists the published content as it is now.
      if (url.pathname === "/sitemap.xml") await contextOf();
      const answered =
        seoFile(request, entry, origin, () => latest.published) ??
        (await front.handle?.(request)) ??
        (await served(
          request,
          (app) => ({ app: { ...app, site: entry.name, login: front }, site: entry.name, origin }),
          entry.name,
        ));
      return asked === entry.domain ? answered : withHeader(answered, "x-robots-tag", "noindex");
    }
    // Then the login sees every request (pages, server functions and files alike): its own
    // routes, and any it will not let through.
    return (await login.handle?.(request)) ?? served(request, (app) => ({ app, origin: requestOrigin(request) }));
  }

  /**
   * What the host has for the request, else Start's answer, in the context `asked` makes of the
   * snapshot as it is now: a file never waits for the snapshot to be checked.
   */
  const served = async (request: Request, asked: (app: AppContext) => RequestContext, site?: string) =>
    (await options.files?.(request, site)) ??
    (await options.entry.fetch(request, { context: asked(await contextOf()) }));

  return {
    context,
    hosts,
    domains,
    async fetch(request) {
      try {
        return await answer(request);
      } catch (err) {
        console.error("sanoma app: request failed:", err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    },
  };
}

/** `response` with the header set: a copy, since a response another made may have its headers fixed. */
function withHeader(response: Response, name: string, value: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(name, value);
  return copy;
}

/** The route each path is answered by: refuses two routes of one path, `/healthz`, a path with a query. */
function ingressOf(routes: readonly IngressRoute[]): (path: string) => IngressRoute | undefined {
  const exact = new Map<string, IngressRoute>();
  for (const route of routes) {
    if (!/^\/[^?#]*$/.test(route.path) || route.path === "/healthz")
      throw new Error(
        `An ingress route's path starts with /, has no query and is not /healthz, unlike "${route.path}"`,
      );
    if (route.prefix && route.path.endsWith("/"))
      throw new Error(`A prefix ingress route's path does not end with /, unlike "${route.path}"`);
    if (exact.has(route.path))
      throw new Error(`Two ingress routes have the path ${route.path}: give each path one route`);
    exact.set(route.path, route);
  }
  // Longest first, so the first under which a path falls is the most specific.
  const prefixed = [...exact.values()].filter((r) => r.prefix).toSorted((a, b) => b.path.length - a.path.length);
  return (path) => exact.get(path) ?? prefixed.find((route) => path.startsWith(`${route.path}/`));
}

/** A public site's host on this machine. */
export const localHost = (site: string) => `${siteHost(site)}.localhost`;

/**
 * Each public site's hosts, to its entry (a copy, with its `domain`): `<name>.localhost`, and the
 * domain `domains` gives it. A domain naming a site that is missing or not public is warned about
 * and served nowhere; so is a host another site has first (one site per host).
 */
function publicHosts(
  description: ConfigDescription,
  domains: Readonly<Record<string, string>>,
): Map<string, SiteEntry> {
  const hosts = new Map<string, SiteEntry>();
  const claim = (host: string, site: SiteEntry) => {
    if (!hosts.has(host)) return void hosts.set(host, site);
    console.warn(`sanoma app: ${host} is another public site's host: ${siteDir(site.name)} is not served there`);
  };
  const entries = new Map(description.sites.filter((site) => site.public).map((site) => [site.name, { ...site }]));
  for (const site of entries.values()) claim(localHost(site.name), site);
  for (const [name, domain] of Object.entries(domains)) {
    const site = entries.get(name);
    if (!site) {
      console.warn(`sanoma app: the domain ${domain} names ${siteDir(name)}, which is not a public site: not served`);
      continue;
    }
    const host = domain.toLowerCase();
    claim(host, site);
    if (hosts.get(host) === site) site.domain = host;
  }
  return hosts;
}
