// Importing nothing, so the router (in the browser) and `startApp`'s sitemap (Node) share it.

/** A route tree's path on `site`'s own host, where its routes are at the root: `/sites/<site>/blog` is `/blog`. */
export function sitePath(site: string, path: string): string {
  const prefix = `/sites/${site}`;
  return path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}
