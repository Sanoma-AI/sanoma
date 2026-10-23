import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { NotFound, PagePending, RouteError, SiteError, SiteNotFound } from "./components/boundaries.tsx";
import { routeTree } from "#/routeTree.gen.ts";
import { sitePath } from "./site-path.ts";
import { pageHost } from "./site-url.ts";

/** `/…` on the site's host ↔ `/sites/<site>/…` in the route tree: the site's routes at the root of its host. */
function siteRewrite(site: string) {
  return {
    input: ({ url }: { url: URL }) => {
      url.pathname = `/sites/${site}${url.pathname}`;
      return url;
    },
    output: ({ url }: { url: URL }) => {
      url.pathname = sitePath(site, url.pathname);
      return url;
    },
  };
}

/** A router per request on the server, one for the page's life in the browser. */
export function getRouter() {
  // Inside getRouter, never at module scope: a shared client would leak one request's data into another's HTML.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } });
  // On a public site's host (startApp's host table); never from the URL's host.
  const { site } = pageHost();
  const router = createRouter({
    routeTree,
    context: { queryClient, site },
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
