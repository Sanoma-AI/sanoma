import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useLoaderData, useMatches } from "@tanstack/react-router";
import { Fragment, lazy, Suspense, useEffect } from "react";
import { AppSidebar, useSidebarWidths } from "#/components/app-sidebar.tsx";
import { DensityProvider } from "#/components/density.tsx";
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
import { actorQuery } from "../queries.ts";
import { useCrumbs } from "./common.tsx";

// The app's chrome around every page on the app's host: the sidebar, the crumbs, who you are.
// The root loads it lazily, so a public site's host never does.

/** Asked once per browser, so loaded only when no name is stored. */
const WhoAreYou = lazy(() => import("./who-are-you.tsx"));

/** The chrome: the sidebar and its panels, the crumbs, the page's column, and the dialogs. */
export default function Root() {
  const { data: server } = useSuspenseQuery(actorQuery());
  const actor = useActorState(server);
  // With the default login, a name chosen here is asked about again: who the server admits it as.
  const queryClient = useQueryClient();
  const said = server.actor?.id ?? null;
  useEffect(() => {
    if (!actor.fromServer && actor.actor && actor.actor !== said)
      void queryClient.invalidateQueries({ queryKey: actorQuery().queryKey });
  }, [actor.fromServer, actor.actor, said, queryClient]);
  // Only these fields: the root's loader data is new on every navigation, a field is not.
  const sidebarOpen = useLoaderData({ from: "__root__", select: (data) => data?.sidebarOpen ?? true });
  const compact = useLoaderData({ from: "__root__", select: (data) => data?.compact ?? false });
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
