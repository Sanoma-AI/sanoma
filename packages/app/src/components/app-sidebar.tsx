import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, linkOptions } from "@tanstack/react-router";
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

/** The sidebar's nav. (Each page's own name is its route's crumb.) */
const PAGES = linkOptions([
  { to: "/runs", label: "Runs", icon: ActivityIcon },
  { to: "/inbox", label: "Inbox", icon: InboxIcon },
  { to: "/start", label: "Start", icon: PlayIcon },
  { to: "/workflows", label: "Workflows", icon: WorkflowIcon },
]);

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
