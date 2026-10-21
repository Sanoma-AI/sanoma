import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import type { SiteDefinition } from "../site.ts";

// A company's sites, for the sidebar's Sites panel and the crumbs: each site the build mounts
// under /sites/<name>, named by its `site.ts`, with its pages from the router's tree.

/**
 * Each site's `sites/<name>/site.ts` default export (`defineSite`), by its folder's name; a
 * `site.ts` without one names nothing. Root-relative: the root is the company repo in its build,
 * and in the package's own build the package, where it matches nothing.
 */
const DEFINED: Record<string, SiteDefinition | undefined> = Object.fromEntries(
  Object.entries(import.meta.glob<{ default?: SiteDefinition }>("/sites/*/site.ts", { eager: true })).map(
    ([file, module]) => [file.split("/")[2], module.default],
  ),
);

/** The site a route path is in (`/sites/<name>…`), by its folder's name. */
export const siteOf = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : /^\/sites\/([^/]+)/.exec(path)?.[1];

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
 * with a path parameter is left out: it has no one URL to list (a site of only those lists none).
 */
export function useSites(): Site[] {
  const { routesByPath } = useRouter();
  return useMemo(() => {
    // In path order, by code unit (the same on the server and in any browser's locale): the sites
    // by name, and each site's home before its other pages.
    const sites = new Map<string, Site>();
    for (const [to, route] of Object.entries(routesByPath).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = siteOf(to);
      if (name === undefined) continue;
      const site = sites.get(name) ?? {
        name,
        title: DEFINED[name]?.title ?? name,
        icon: DEFINED[name]?.icon,
        pages: [],
      };
      sites.set(name, site);
      if (to.includes("$")) continue;
      const rest = to.slice(`/sites/${name}`.length);
      site.pages.push({ to, label: route.options.staticData?.crumb ?? (rest === "" ? "Home" : rest) });
    }
    return [...sites.values()];
  }, [routesByPath]);
}
