import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import type { SiteEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
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
import { usePublicAddress, useSites } from "#/lib/sites.ts";
import { configQuery } from "../../queries.ts";
import { ACTIVE, PanelHeader } from "./panel.tsx";

// The Sites section's panel: the company's sites, each under its title with its pages.

/** Each site under its title (and icon), a public one's own address, and its pages, the open one marked. */
export function SitesPanel() {
  const sites = useSites();
  const { data: publicSites } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => new Map(config.sites.filter((site) => site.public).map((site) => [site.name, site])),
  });
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
                {publicSites.has(name) && <PublicAddress site={publicSites.get(name)!} />}
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

/** A public site's own address, where visitors see it at the root of its host, in a new tab. */
function PublicAddress({ site }: { site: SiteEntry }) {
  const href = usePublicAddress(site);
  if (!href) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<a href={href} target="_blank" rel="noreferrer" />}>
        <ArrowSquareOutIcon aria-hidden="true" />
        <span className="truncate">{new URL(href).host}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
