// Importing nothing, so the router and the Sites page (in the browser) and `startApp`'s sitemap (Node) share them.

/** A public site's host label on this machine: its key with the app last, `crm/pipeline` as `pipeline.crm` (`<label>.localhost`). */
export const siteHost = (site: string): string => site.split("/").toReversed().join(".");

/** A route tree's path on `site`'s own host, where its routes are at the root: `/sites/<site>/blog` is `/blog`. */
export function sitePath(site: string, path: string): string {
  const prefix = `/sites/${site}`;
  return path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}

/**
 * Where a public site's own host finds a file at `path` (decoded): the site's public file at its
 * root, `/sites/<site>/<path>`; none under `/sites/`, where only the app's host has every site's.
 */
export const publicPath = (site: string, path: string): string | undefined =>
  path.startsWith("/sites/") ? undefined : `/sites/${site}${path}`;

/** A path the Worker looks among its assets for: its last segment has an extension (`mount.js`). */
export const hasExtension = (path: string): boolean => /\.[^/]+$/.test(path);

/**
 * The path a request asks a file at, decoded: a GET's or a HEAD's, never a server function's, and
 * only one a URL keeps as it is, so no `..`, `\` or `?` decoded from it steps out of a site's
 * folder once `publicPath` puts it there (`/..%2Fother/x.js`).
 */
export function filePath(request: Request): string | undefined {
  const { pathname } = new URL(request.url);
  if ((request.method !== "GET" && request.method !== "HEAD") || pathname.startsWith("/_serverFn/")) return undefined;
  try {
    const path = decodeURIComponent(pathname);
    return decodeURIComponent(new URL(path, "http://file").pathname) === path ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A route path as its page's URL: no optional segment, and a character escaped in its file's name (`feed[.]xml`) as it is. */
export const pageUrl = (path: string): string => withoutOptional(path).replaceAll(/\[([^\]]*)\]/g, "$1");

/** A route path without its optional parameters (`{-$locale}`): the page's path when none is given. */
export const withoutOptional = (path: string): string => path.replace(/\/\{-\$[^}]*\}/g, "");

/** A route path with no required parameter (`$id`; an optional `{-$locale}` is none), so one URL to list or link. */
export const hasOneUrl = (path: string): boolean => !withoutOptional(path).includes("$");

/** Where a site's pages take their language: TanStack's optional path parameter, first in the site's routes. */
export const LOCALE_SEGMENT = "/{-$locale}";

/** Whether a route path is a page of `site` in its languages: under `/sites/<site>/{-$locale}`. */
export const isLocalized = (site: string, path: string): boolean => path.startsWith(`/sites/${site}${LOCALE_SEGMENT}`);

/**
 * A page's `hreflang` links, from its URL in each language it is in, in its site's order: none in
 * fewer than two, and its default's again as `x-default` when it is in that. The head's and the
 * sitemap's alike.
 */
export function alternatesOf(
  found: readonly { locale: string; href: string }[],
  defaultLocale: string | undefined,
): { locale: string; href: string }[] {
  if (found.length < 2) return [];
  return [...found, ...(found[0]!.locale === defaultLocale ? [{ locale: "x-default", href: found[0]!.href }] : [])];
}
