import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { NotFound, PagePending, RouteError } from "./components/boundaries.tsx";
import { routeTree } from "./routeTree.gen.ts";

/** A router per request on the server, one for the page's life in the browser. */
export function getRouter() {
  // Inside getRouter, never at module scope: a shared client would leak one request's data into another's HTML.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // The query client decides what is fresh: a preload runs the loaders, which load only what it lacks.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Every route gets these, inside the root's layout: a page that fails or is missing keeps the sidebar.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    defaultPendingComponent: PagePending,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
