import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { NotFound, PagePending, RouteError, SiteError, SiteNotFound } from "./components/boundaries.tsx";
import { routeTree } from "#/routeTree.gen.ts";

/**
 * The public site this request or page is on, on its own host: on the server, what `startApp`
 * put in the request's context (its host table); in the browser, what the server wrote on
 * `<html data-site>`. Never the URL's host, which a proxy may change.
 */
const publicSite = createIsomorphicFn()
  .server((): string | undefined => {
    // Start makes a router outside the request's context only to follow a server function's
    // redirect, which then resolves as on the app's host.
    try {
      return getGlobalStartContext()?.site;
    } catch {
      return undefined;
    }
  })
  .client((): string | undefined => document.documentElement.dataset.site || undefined);

/**
 * The page's origin, as the browser asked for it: on the server, the request's (its scheme from
 * `x-forwarded-proto` behind a proxy that ends TLS); in the browser, `location`'s. For the absolute
 * links a page's head gives (`hreflang`).
 */
const pageOrigin = createIsomorphicFn()
  .server((): string | undefined => {
    try {
      return getRequestUrl({ xForwardedProto: true }).origin;
    } catch {
      return undefined;
    }
  })
  .client((): string => location.origin);

/** `/…` on the site's host ↔ `/sites/<site>/…` in the route tree: the site's routes at the root of its host. */
function siteRewrite(site: string) {
  const prefix = `/sites/${site}`;
  return {
    input: ({ url }: { url: URL }) => {
      url.pathname = prefix + url.pathname;
      return url;
    },
    output: ({ url }: { url: URL }) => {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        url.pathname = url.pathname.slice(prefix.length) || "/";
      }
      return url;
    },
  };
}

/** A router per request on the server, one for the page's life in the browser. */
export function getRouter() {
  // Inside getRouter, never at module scope: a shared client would leak one request's data into another's HTML.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } });
  const site = publicSite();
  const router = createRouter({
    routeTree,
    context: { queryClient, site, ...(site && { origin: pageOrigin() }) },
    ...(site && { rewrite: siteRewrite(site) }),
    defaultPreload: "intent",
    // The query client decides what is fresh: a preload runs the loaders, which load only what it lacks.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Every route gets these, inside the root's layout: a page that fails or is missing keeps the
    // chrome. On a public site's host, plain ones.
    defaultErrorComponent: site ? SiteError : RouteError,
    defaultNotFoundComponent: site ? SiteNotFound : NotFound,
    defaultPendingComponent: PagePending,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
