import type { RunSummary } from "@sanoma/workflows";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link, linkOptions } from "@tanstack/react-router";
import { ActivityIcon, InboxIcon, PlayIcon, PlugIcon, ShieldCheckIcon, WorkflowIcon } from "lucide-react";
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
  SidebarRail,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { configQuery, pendingOf, waitingRunsQuery } from "../queries.ts";

/** The sidebar's nav. (Each page's own name is its route's crumb.) */
const PAGES = linkOptions([
  { to: "/runs", label: "Runs", icon: ActivityIcon },
  { to: "/inbox", label: "Inbox", icon: InboxIcon },
  { to: "/start", label: "Start", icon: PlayIcon },
  { to: "/workflows", label: "Workflows", icon: WorkflowIcon },
  { to: "/connectors", label: "Connectors", icon: PlugIcon },
]);

/** A page's link, lit while its page or one under it shows. */
const ACTIVE = { "data-active": true } as const;

/** The inbox badge's number: the approvals pending, counted as the Inbox page lists them. */
const countPending = (runs: RunSummary[]) => pendingOf(runs).length;

export function AppSidebar() {
  // The root route loads the config before any page renders.
  const { data: config } = useSuspenseQuery(configQuery());
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet over the page: every link in it closes it on the way.
  const close = () => setOpenMobile(false);
  // The Inbox page's query (its costliest read), polled every 30 s for the badge. Each watcher
  // polls at its own interval, so while the Inbox page shows, its 5 s poll keeps the badge
  // fresh too; and a decision refreshes it at once.
  const { data: pending = 0 } = useQuery({ ...waitingRunsQuery(), refetchInterval: 30_000, select: countPending });
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/runs" onClick={close}>
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
                  <ClientOnly>{pending > 0 && <SidebarMenuBadge>{pending}</SidebarMenuBadge>}</ClientOnly>
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
