/**
 * Where the Worker's build writes a site's prerendered pages among its assets,
 * `<prefix>/<site><path>/index.html`, and where the build's own preview renders them. Its own
 * module: the bundle's entry may export nothing but its default (workerd takes each named export
 * of a main module for an entrypoint).
 */
export const PRERENDERED = "/__sanoma/sites";
