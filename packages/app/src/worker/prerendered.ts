/**
 * Where the Worker's build writes a site's prerendered pages among its assets,
 * `<prerenderedDir><path>/index.html`, and where the build's own preview renders them. Its own
 * module: the bundle's entry may export nothing but its default (workerd takes each named export
 * of a main module for an entrypoint).
 */
export const PRERENDERED = "/__sanoma/sites";

/**
 * A site's folder under `PRERENDERED`: its key as one segment, an app's site (`<app>/<name>`) as
 * `<app>.<name>`, since no key has a dot, so a page's path never reads as part of the key.
 */
export const prerenderedDir = (site: string) => `${PRERENDERED}/${site.replace("/", ".")}`;
