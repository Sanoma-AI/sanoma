import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import type { SiteDefinition } from "../site.ts";

// A company's sites, for the sidebar's Sites panel and the crumbs: each site the build mounts
// under /sites/<name>, named by its `site.ts`, with its pages from the router's tree.

/**
 * Each site's `sites/<name>/site.ts` default export (`defineSite`), by its folder's name.
 * Root-relative: the root is the company repo in its build, and in the package's own build the
 * package, where it matches nothing.
 */
const DEFINED: Record<string, SiteDefinition | undefined> = Object.fromEntries(
  Object.entries(
    import.meta.glob<SiteDefinition | undefined>("/sites/*/site.ts", { eager: true, import: "default" }),
  ).map(([file, site]) => [file.split("/")[2], site]),
);

/** The site a route path is in (`/sites/<name>…`), by its folder's name. */
export const siteOf = (path: string): string | undefined => /^\/sites\/([^/]+)/.exec(path)?.[1];

/** A site's name: its `defineSite` title, else its folder's. */
export const siteTitle = (name: string): string => DEFINED[name]?.title ?? name;

/** A site in the Sites panel: its title and icon, and its pages, the site's home first. */
export interface Site {
  name: string;
  title: string;
  icon: SiteDefinition["icon"];
  pages: { to: string; label: string }[];
}

/**
 * The build's sites, by name, each with the pages under it (no trailing slash, as typed paths
 * are): a page's label is its route's `staticData.crumb`, else its path under the site. A page
 * with a path parameter is left out: it has no one URL to list.
 */
export function useSites(): Site[] {
  const { routesByPath } = useRouter();
  return useMemo(() => {
    const sites = new Map<string, Site>();
    for (const [to, route] of Object.entries(routesByPath)) {
      const name = siteOf(to);
      if (name === undefined || to.includes("$")) continue;
      const site = sites.get(name) ?? { name, title: siteTitle(name), icon: DEFINED[name]?.icon, pages: [] };
      sites.set(name, site);
      const rest = to.slice(`/sites/${name}`.length);
      site.pages.push({ to, label: route.options.staticData?.crumb ?? (rest === "" ? "Home" : rest) });
    }
    return [...sites.values()]
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((site) => ({ ...site, pages: site.pages.toSorted((a, b) => a.to.localeCompare(b.to)) }));
  }, [routesByPath]);
}
