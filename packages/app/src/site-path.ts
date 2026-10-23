// Importing nothing, so the router and the Sites page (in the browser) and `startApp`'s sitemap (Node) share them.

/** A route tree's path on `site`'s own host, where its routes are at the root: `/sites/<site>/blog` is `/blog`. */
export function sitePath(site: string, path: string): string {
  const prefix = `/sites/${site}`;
  return path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}

/** A route path without its optional parameters (`{-$locale}`): the page's path when none is given. */
export const withoutOptional = (path: string): string => path.replace(/\/\{-\$[^}]*\}/g, "");

/** A route path with no required parameter (`$id`; an optional `{-$locale}` is none), so one URL to list or link. */
export const hasOneUrl = (path: string): boolean => !withoutOptional(path).includes("$");
