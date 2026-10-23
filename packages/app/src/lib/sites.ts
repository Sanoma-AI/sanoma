import { isLoopback } from "@sanoma-ai/workflows/shared";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useSyncExternalStore } from "react";
import type { SiteDefinition } from "../site.ts";
import { hasOneUrl, sitePath, withoutOptional } from "../site-path.ts";
import { siteOf } from "./locales.ts";

// A company's sites, for the Sites page, the bar and the crumbs: each site the build mounts
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

/** A site on the Sites page: its title and icon, and its pages, the site's home first. */
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
 * An optional one is not: a page under `{-$locale}` is listed in the site's default language,
 * its label without it.
 */
export function useSites(): Site[] {
  const { routesByPath } = useRouter();
  return useMemo(() => {
    // In path order, by code unit (the same on the server and in any browser's locale), optional
    // parameters left out: the sites by name, and each site's home before its other pages.
    const sites = new Map<string, Site>();
    const byPath = Object.entries(routesByPath).map(([to, route]) => [withoutOptional(to), to, route] as const);
    for (const [, to, route] of byPath.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = siteOf(to);
      if (name === undefined) continue;
      const site = sites.get(name) ?? {
        name,
        title: DEFINED[name]?.title ?? name,
        icon: DEFINED[name]?.icon,
        pages: [],
      };
      sites.set(name, site);
      if (!hasOneUrl(to)) continue;
      const path = sitePath(name, withoutOptional(to));
      site.pages.push({ to, label: route.options.staticData?.crumb ?? (path === "/" ? "Home" : path) });
    }
    return [...sites.values()];
  }, [routesByPath]);
}

/** The page's address, as much of `location` as a public site's address needs. */
type PageAddress = Pick<Location, "protocol" | "hostname" | "port">;

/**
 * Where a public site answers at the root of its own host: its domain, when it has one; else, on a
 * page of this machine, `<name>.localhost` on the page's port; else nowhere this page can link to.
 */
export function publicAddress(site: { name: string; domain?: string }, page?: PageAddress): string | undefined {
  if (site.domain) return `https://${site.domain}/`;
  if (!page || !isLoopback(page.hostname)) return undefined;
  return `${page.protocol}//${site.name}.localhost${page.port ? `:${page.port}` : ""}/`;
}

const unchanging = () => () => {};

/** `publicAddress` on this page: the server, and the browser while it hydrates, know only a domain. */
export const usePublicAddress = (site: { name: string; domain?: string }): string | undefined =>
  useSyncExternalStore(
    unchanging,
    () => publicAddress(site, location),
    () => publicAddress(site),
  );
