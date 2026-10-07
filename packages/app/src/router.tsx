import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen.ts";

/** A router per request on the server, one for the page's life in the browser. */
export function getRouter() {
  // Inside getRouter, never at module scope: a shared client would leak one request's data into another's HTML.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
