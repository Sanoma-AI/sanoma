import { Link } from "@tanstack/react-router";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { useSites } from "#/lib/sites.ts";
import { ACTIVE, PanelHeader } from "./panel.tsx";

// The Sites section's panel: the company's sites, each under its title with its pages.

/** Each site under its title (and icon), and its pages, the open one marked. */
export function SitesPanel() {
  const sites = useSites();
  return (
    <>
      <PanelHeader section="sites" title="Sites" />
      <SidebarContent>
        {sites.map(({ name, title, icon: Icon, pages }) => (
          <SidebarGroup key={name}>
            <SidebarGroupLabel render={<h3 />}>
              {Icon && <Icon />}
              {title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pages.map(({ to, label }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      render={
                        <Link to={to} activeOptions={{ exact: true, includeSearch: false }} activeProps={ACTIVE} />
                      }
                    >
                      <span className="truncate">{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </>
  );
}
