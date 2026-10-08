import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useLocation,
  useMatch,
} from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { ThemeProvider } from "next-themes";
import { lazy, type ReactNode, Suspense } from "react";
import { AppSidebar, PAGES } from "#/components/app-sidebar.tsx";
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
import { actorQuery, configQuery } from "../queries.ts";
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
  // query holds (here, whether the sidebar was left open), since the page carries loader data too.
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.query({ ...actorQuery(), staleTime: "static" }),
      queryClient.query({ ...configQuery(), staleTime: "static" }),
    ]);
    return { sidebarOpen: readSidebarOpen() };
  },
  // The document, around everything the root renders: its page, error or not-found included.
  shellComponent: Document,
  component: Root,
});

/** The sidebar's own cookie, which it writes as it opens and closes: open unless it says closed. */
const readSidebarOpen = createIsomorphicFn()
  .server(() => getCookie("sidebar_state") !== "false")
  .client(() => !document.cookie.split("; ").includes("sidebar_state=false"));

/** Asked once per browser, so loaded only when no name is stored. */
const WhoAreYou = lazy(() => import("../components/who-are-you.tsx"));

function Root() {
  const { data: server } = useQuery(actorQuery());
  const actor = useActorState(server);
  const { sidebarOpen } = Route.useLoaderData();
  return (
    <ActorContext value={actor}>
      {/* Radix's tooltips need one provider: the sidebar's, and any a page shows. */}
      <TooltipProvider>
        <div id="app">
          <SidebarProvider defaultOpen={sidebarOpen}>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                <div className="flex items-center gap-2 px-4">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
                  <Crumbs />
                </div>
              </header>
              <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 pt-0 sm:px-6">
                <Outlet />
              </div>
            </SidebarInset>
          </SidebarProvider>
          {!actor.fromServer && actor.actor === null && (
            <Suspense fallback={null}>
              <WhoAreYou />
            </Suspense>
          )}
          <Toaster />
        </div>
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

/** Where you are: the page, or Runs and the run's workflow. */
function Crumbs() {
  const pathname = useLocation({ select: (location) => location.pathname });
  // A run that does not exist has no loader data: its id stands in.
  const run = useMatch({ from: "/runs/$id", shouldThrow: false });
  const page = PAGES.find(({ to }) => pathname === to || pathname.startsWith(`${to}/`));
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {run ? (
          <>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink asChild>
                <Link to="/runs">Runs</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>{run.loaderData?.workflow ?? run.params.id}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : (
          <BreadcrumbItem>
            <BreadcrumbPage>{page?.title ?? "Not found"}</BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
