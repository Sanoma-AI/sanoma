import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ActivityIcon, InboxIcon, PlayIcon, ShieldCheckIcon, WorkflowIcon } from "lucide-react";
import { NavMain } from "#/components/nav-main.tsx";
import { NavUser } from "#/components/nav-user.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "#/components/ui/sidebar.tsx";
import { configQuery } from "../queries.ts";

/** The app's pages: the sidebar's nav, and the header's breadcrumb, which uses `title`. */
export const PAGES = [
  { to: "/runs", label: "Runs", title: "Runs", icon: ActivityIcon },
  { to: "/inbox", label: "Inbox", title: "Inbox", icon: InboxIcon },
  { to: "/start", label: "Start", title: "Start a run", icon: PlayIcon },
  { to: "/workflows", label: "Workflows", title: "Workflows", icon: WorkflowIcon },
] as const;

export function AppSidebar() {
  // The root route loads the config before any page renders.
  const { data: config } = useSuspenseQuery(configQuery());
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/runs">
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
        <NavMain items={PAGES} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
