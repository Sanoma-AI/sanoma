import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { pendingApprovals } from "../api.ts";
import { waitingRunsQuery } from "../queries.ts";

/** A page's link, lit while its page or one under it shows. */
const ACTIVE = { "data-active": true } as const;

export function NavMain({
  items,
}: {
  items: readonly { to: NonNullable<LinkProps["to"]>; label: string; icon: LucideIcon }[];
}) {
  const { setOpenMobile } = useSidebar();
  // The Inbox page's own query, so it costs that page nothing.
  const pending =
    useQuery({
      ...waitingRunsQuery(),
      select: (runs) => runs.reduce((n, run) => n + pendingApprovals(run).length, 0),
    }).data ?? 0;
  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton asChild tooltip={item.label}>
              {/* On a phone the sidebar is a sheet over the page: close it on the way. */}
              <Link to={item.to} activeProps={ACTIVE} onClick={() => setOpenMobile(false)}>
                <item.icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
            {item.to === "/inbox" && pending > 0 && <SidebarMenuBadge>{pending}</SidebarMenuBadge>}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
