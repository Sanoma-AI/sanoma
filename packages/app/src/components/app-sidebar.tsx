import type { RunSummary } from "@sanoma/workflows";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link, linkOptions } from "@tanstack/react-router";
import { BoxesIcon, InboxIcon, PlayIcon, PlugIcon, ShieldCheckIcon, WorkflowIcon } from "lucide-react";
import { NavUser } from "#/components/nav-user.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { configQuery, pendingOf, waitingRunsQuery } from "../queries.ts";

/** The sidebar's nav. (Each page's own name is its route's crumb.) */
const PAGES = linkOptions([
  { to: "/inbox", label: "Inbox", icon: InboxIcon },
  { to: "/start", label: "Start", icon: PlayIcon },
  { to: "/workflows", label: "Workflows", icon: WorkflowIcon },
  { to: "/resources", label: "Resources", icon: BoxesIcon },
  { to: "/connectors", label: "Connectors", icon: PlugIcon },
]);

/** A page's link, lit while its page or one under it shows. */
const ACTIVE = { "data-active": true } as const;

/**
 * The approvals pending, counted as the Inbox page lists them: all of them, for the inbox's badge,
 * and by workflow, for each workflow's. A plain object, so a poll that changed nothing keeps it.
 */
const countPending = (runs: RunSummary[]) => {
  const pending = pendingOf(runs);
  const byWorkflow: Record<string, number> = Object.create(null);
  for (const { run } of pending) byWorkflow[run.workflow] = (byWorkflow[run.workflow] ?? 0) + 1;
  return { total: pending.length, byWorkflow };
};

export function AppSidebar() {
  // The root route loads the config before any page renders.
  const { data: config } = useSuspenseQuery(configQuery());
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet over the page: every link in it closes it on the way.
  const close = () => setOpenMobile(false);
  // The Inbox page's query (its costliest read), polled every 30 s for the badge. Each watcher
  // polls at its own interval, so while the Inbox page shows, its 5 s poll keeps the badge
  // fresh too; and a decision refreshes it at once.
  const { data: pending } = useQuery({ ...waitingRunsQuery(), refetchInterval: 30_000, select: countPending });
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/workflows" onClick={close}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldCheckIcon />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Sanoma</span>
                  <span className="truncate text-xs">{config.appName}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {PAGES.map(({ label, icon: Icon, ...link }) => (
              <SidebarMenuItem key={link.to}>
                <SidebarMenuButton asChild tooltip={label}>
                  <Link {...link} activeProps={ACTIVE} onClick={close}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
                {/* After hydration only: the root loader starts this query without waiting for it,
                    so the server may render before it answers and the browser after. */}
                {link.to === "/inbox" && (
                  <ClientOnly>
                    {pending && pending.total > 0 && <SidebarMenuBadge>{pending.total}</SidebarMenuBadge>}
                  </ClientOnly>
                )}
                {/* Each workflow's page, with how many approvals its runs wait on. Hidden in icon mode. */}
                {link.to === "/workflows" && config.workflows.length > 0 && (
                  <SidebarMenuSub>
                    {config.workflows.map((wf) => (
                      <SidebarMenuSubItem key={wf.name}>
                        <SidebarMenuSubButton asChild>
                          <Link to="/workflows/$name" params={{ name: wf.name }} activeProps={ACTIVE} onClick={close}>
                            <span className="truncate">{wf.title ?? wf.name}</span>
                            {/* Not SidebarMenuBadge: its offset is set for a menu button, not a sub-item's. */}
                            <ClientOnly>
                              {!!pending?.byWorkflow[wf.name] && (
                                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                                  {pending.byWorkflow[wf.name]}
                                </span>
                              )}
                            </ClientOnly>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
