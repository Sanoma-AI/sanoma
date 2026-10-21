import { type QueryClient, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, useMatches } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { ThemeProvider } from "next-themes";
import { Fragment, lazy, type ReactNode, Suspense, useEffect } from "react";
import { AppSidebar, useSidebarWidths } from "#/components/app-sidebar.tsx";
import { DENSITY_COOKIE, DensityProvider } from "#/components/density.tsx";
import { NewWorkflowDialog } from "#/components/new-workflow.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import { ActorContext, useActorState } from "../actor.ts";
import { useCrumbs } from "../components/common.tsx";
import { actorQuery, configQuery, waitingRunsQuery } from "../queries.ts";
// lucide's shield-check, the sidebar's brand icon.
import favicon from "../favicon.svg?url";
import css from "../style.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "Sanoma" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      // Without an icon the browser asks for /favicon.ico, and gets a 404.
      { rel: "icon", type: "image/svg+xml", href: favicon },
    ],
  }),
  // Pages show what is happening now: never cache them.
  headers: () => ({ "cache-control": "no-store" }),
  // Who the server says is asking, in the first render: a deployment's login shows at once.
  // And the config, which every page reads and which cannot change while the app runs.
  // Both stay in the query client, where the page reads them: a loader returns only what no
  // query holds (here, whether the sidebar was left open, and the density), since the page
  // carries loader data too.
  loader: async ({ context: { queryClient } }) => {
    // The inbox badge's count, started here and not awaited: it streams in with the page, and a
    // slow or failed read never holds the page up (the badge shows nothing until it comes).
    void queryClient.query(waitingRunsQuery()).catch(() => {});
    await Promise.all([
      queryClient.query({ ...actorQuery(), staleTime: "static" }),
      queryClient.query({ ...configQuery(), staleTime: "static" }),
    ]);
    return readPrefs();
  },
  // The document, around everything the root renders: its page, error or not-found included.
  shellComponent: Document,
  component: Root,
});

/**
 * The cookie the sidebar writes as it opens and closes: SIDEBAR_COOKIE_NAME in ui/sidebar.tsx,
 * which does not export it (and is generated, so not edited).
 */
const SIDEBAR_COOKIE = "sidebar_state";

/**
 * Whether the sidebar's panel was left open (open unless its cookie says closed) and whether the
 * page is Compact (DensityProvider says why a cookie), from the request's cookies on the server
 * and `document.cookie` in the browser. Each takes its value once, as it mounts: the first render
 * is hydration, which has the server's answer; reading it in the browser too keeps a later
 * remount (an error boundary's retry, say) on the cookie's side for both.
 */
const readPrefs = createIsomorphicFn()
  .server(() => ({
    sidebarOpen: getCookie(SIDEBAR_COOKIE) !== "false",
    compact: getCookie(DENSITY_COOKIE) === "compact",
  }))
  .client(() => ({
    sidebarOpen: cookieValue(SIDEBAR_COOKIE) !== "false",
    compact: cookieValue(DENSITY_COOKIE) === "compact",
  }));

/** A cookie's value in the browser, or undefined when it is not set. */
function cookieValue(name: string) {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Asked once per browser, so loaded only when no name is stored. */
const WhoAreYou = lazy(() => import("../components/who-are-you.tsx"));

function Root() {
  const { data: server } = useSuspenseQuery(actorQuery());
  const actor = useActorState(server);
  // With the default login, a name chosen here is asked about again: who the server admits it as.
  const queryClient = useQueryClient();
  const said = server.actor?.id ?? null;
  useEffect(() => {
    if (!actor.fromServer && actor.actor !== undefined && actor.actor !== said)
      void queryClient.invalidateQueries({ queryKey: actorQuery().queryKey });
  }, [actor.fromServer, actor.actor, said, queryClient]);
  // Only these fields: the root's loader data is new on every navigation, a field is not.
  const sidebarOpen = Route.useLoaderData({ select: (data) => data.sidebarOpen });
  const compact = Route.useLoaderData({ select: (data) => data.compact });
  // A page that asks for it (a workflow's, for its graph) takes the full width.
  const wide = useMatches({ select: (matches) => matches.some((match) => match.staticData.wide) });
  // The section bar, and beside it the section's panel when it has one.
  const widths = useSidebarWidths();
  return (
    <ActorContext value={actor}>
      {/* One provider for every tooltip: the sidebar's, and any a page shows. */}
      <TooltipProvider>
        <DensityProvider defaultCompact={compact}>
          <SidebarProvider defaultOpen={sidebarOpen} style={widths}>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-12 shrink-0 items-center gap-2 px-4">
                {/* On a phone the sidebar is a sheet: this opens it. Elsewhere its panel's button, its
                    rail or Ctrl+B folds the panel. */}
                <div className="contents md:hidden">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
                </div>
                <Crumbs />
              </header>
              {/* The page column: a page's regions are its children, the region gap apart. */}
              <div
                data-wide={wide || undefined}
                className="mx-auto flex w-full max-w-6xl flex-col gap-(--gap-region) p-4 pt-0 data-wide:max-w-none sm:px-6"
              >
                <Outlet />
              </div>
            </SidebarInset>
          </SidebarProvider>
          <NewWorkflowDialog />
          {!actor.fromServer && actor.actor === null && (
            <Suspense fallback={null}>
              <WhoAreYou />
            </Suspense>
          )}
          <Toaster />
        </DensityProvider>
      </TooltipProvider>
    </ActorContext>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    // next-themes' script sets the class on <html> before the body paints, so React finds it changed.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Light, dark or the system's, kept in localStorage. style.css sets color-scheme with the class. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme={false}
          storageKey="sanoma.theme"
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

/** Where you are: the crumbs of the pages matched, each but the last a link to its page. */
function Crumbs() {
  const crumbs = useCrumbs();
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map(({ id, pathname, label }, i) =>
          i < crumbs.length - 1 ? (
            <Fragment key={id}>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to={pathname} />}>{label}</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </Fragment>
          ) : (
            <BreadcrumbItem key={id}>
              <BreadcrumbPage>{label}</BreadcrumbPage>
            </BreadcrumbItem>
          ),
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
