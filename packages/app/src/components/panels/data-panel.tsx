import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { configQuery } from "../../queries.ts";
import { ACTIVE, PanelFooterLink, PanelHeader } from "./panel.tsx";

// The Data section's panel: the config's collections, each linking to its grid.

/** Each collection by its title, the open one marked, and at the foot the list of them all. */
export function DataPanel() {
  const { data: collections } = useSuspenseQuery({ ...configQuery(), select: (config) => config.collections });
  return (
    <>
      <PanelHeader section="data" title="Data" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {collections.map(({ name, title }) => (
                <SidebarMenuItem key={name}>
                  <SidebarMenuButton
                    render={
                      <Link
                        to="/data/$name"
                        params={{ name }}
                        activeOptions={{ includeSearch: false }}
                        activeProps={ACTIVE}
                      />
                    }
                  >
                    <span className="truncate">{title ?? name}</span>
                    <code className="ml-auto shrink-0 text-xs text-muted-foreground">{name}</code>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <PanelFooterLink link={<Link to="/data" />}>
        All {collections.length} collection{collections.length === 1 ? "" : "s"}
      </PanelFooterLink>
    </>
  );
}
