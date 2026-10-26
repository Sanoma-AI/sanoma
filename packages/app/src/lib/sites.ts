import { isLoopback } from "@sanoma-ai/workflows/shared";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useSyncExternalStore } from "react";
import type { SiteDefinition } from "../site.ts";
import { hasOneUrl, siteHost, sitePath, withoutOptional } from "../site-path.ts";
import { siteOf } from "./locales.ts";

// A company's sites, for the bar, the Sites page and the crumbs: each site the build mounts
// under /sites/<name>, named by its `site.ts`, with its pages from the router's tree.

/**
 * Each site's `sites/<name>/site.ts` (an app's `apps/<app>/sites/<name>/site.ts`) default export
 * (`defineSite`), by its key (`<app>/<name>` for an app's); a `site.ts` without one names nothing.
 * Root-relative: the root is the company repo in its build, and in the package's own build the
 * package, where it matches nothing.
 */
const DEFINED: Record<string, SiteDefinition | undefined> = Object.fromEntries(
  Object.entries(
    import.meta.glob<{ default?: SiteDefinition }>(["/sites/*/site.ts", "/apps/*/sites/*/site.ts"], { eager: true }),
  ).map(([file, module]) => {
    const [, top, app, , site] = file.split("/");
    return [top === "apps" ? `${app}/${site}` : app!, module.default];
  }),
);

/** A site in the bar and on the Sites page: its title and icon, and its pages, the site's home first. */
export interface Site {
  /** Its key: the folder's name, `<app>/<name>` for an app's site. */
  name: string;
  /** The app whose folder holds it; absent for one at the root. */
  app?: string;
  title: string;
  icon: SiteDefinition["icon"];
  /** The app whose folder it comes from, which the bar groups it by: none while the build mounts only the root's `sites/`. */
  app?: string;
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
    for (const [path, to, route] of byPath.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = siteOf(to);
      if (name === undefined) continue;
      const app = name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined;
      const site = sites.get(name) ?? {
        name,
        ...(app !== undefined && { app }),
        title: DEFINED[name]?.title ?? name.slice(name.indexOf("/") + 1),
        icon: DEFINED[name]?.icon,
        pages: [],
      };
      sites.set(name, site);
      if (!hasOneUrl(to)) continue;
      const own = sitePath(name, path);
      site.pages.push({ to, label: route.options.staticData?.crumb ?? (own === "/" ? "Home" : own) });
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
  return `${page.protocol}//${siteHost(site.name)}.localhost${page.port ? `:${page.port}` : ""}/`;
}

const unchanging = () => () => {};

/** `publicAddress` on this page: the server, and the browser while it hydrates, know only a domain. */
export const usePublicAddress = (site: { name: string; domain?: string }): string | undefined =>
  useSyncExternalStore(
    unchanging,
    () => publicAddress(site, location),
    () => publicAddress(site),
  );
