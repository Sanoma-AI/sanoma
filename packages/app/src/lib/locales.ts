import LOCALES from "virtual:sanoma/locales";

// A public site's languages (`defineSite({ locales })`), as its pages' URLs say them: a site puts
// its pages under `routes/{-$locale}/`, TanStack's optional path parameter, so `/about` is in its
// default language and `/fr/about` in French, on its own host as under `/sites/<name>` on the
// app's. The languages come from `site.ts` through the build (`virtual:sanoma/locales`), so the
// public host loads no other site's `site.ts`. Browser and server alike.

/** The site a route path is in (`/sites/<name>…`), by its folder's name. */
export const siteOf = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : /^\/sites\/([^/]+)/.exec(path)?.[1];

/** The folder a site's pages go in to be in each of its languages: the optional parameter `locale`. */
export const LOCALE_SEGMENT = "{-$locale}";

/** A route path under a site, `/sites/<name>/{-$locale}/about`, without its language: `/sites/<name>/about`. */
export const withoutLocale = (path: string): string => path.replace(`/${LOCALE_SEGMENT}`, "");

/** As much of a route match as says its language. */
export interface LocaleMatch {
  routeId: string;
  /** The path as the router matched it: `/sites/<name>/fr/about`, on either host. */
  pathname: string;
  params: Record<string, unknown>;
}

/** The language of a page of a site that has languages. */
export interface PageLocale {
  /** Its folder's name. */
  site: string;
  /** The site's languages, its default first. */
  locales: readonly string[];
  /** The page's: the URL's, else the site's default. */
  locale: string;
  /** Whether the page is under `{-$locale}`, so has a URL in each language. */
  localized: boolean;
  /** False when the URL names a language the site does not have (in its case), or its default (which has no prefix). */
  valid: boolean;
}

/**
 * Whether a route id is under the site's `{-$locale}`: its first segment under `/sites/<name>`,
 * groups and pathless layouts aside (`(marketing)`, `_layout`), as the URL's first segment.
 */
const isLocalized = (routeId: string, site: string): boolean =>
  routeId
    .slice(`/sites/${site}/`.length)
    .split("/")
    .find((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("_")) === LOCALE_SEGMENT;

/** The language of the page `leaf` is (the deepest match), or undefined when its site has none. */
export function pageLocale(leaf: LocaleMatch | undefined): PageLocale | undefined {
  const site = siteOf(leaf?.routeId);
  const locales = site === undefined ? undefined : LOCALES[site];
  if (!leaf || !site || !locales) return undefined;
  const localized = isLocalized(leaf.routeId, site);
  const named = localized && typeof leaf.params.locale === "string" ? leaf.params.locale : undefined;
  // As written: the router matches `/pt-br/` too, which is not `pt-BR`'s URL.
  const valid = named === undefined || (named !== locales[0] && locales.includes(named));
  return { site, locales, locale: valid && named ? named : locales[0]!, localized, valid };
}

/**
 * The page `leaf` is in each of its site's languages, its default first: the path on this host,
 * the site's own (`ownHost`, at its root) or the app's (under `/sites/<name>`), without the
 * search. None for a page that is not under `{-$locale}`.
 */
export function localesOf(leaf: LocaleMatch | undefined, ownHost: boolean): { locale: string; path: string }[] {
  const page = pageLocale(leaf);
  if (!leaf || !page?.localized || !page.valid) return [];
  const prefix = `/sites/${page.site}`;
  const named = page.locale === page.locales[0] ? "" : `/${page.locale}`;
  // An index route's path ends in `/`, which the router's links leave out.
  const rest = leaf.pathname.slice(prefix.length + named.length).replace(/\/$/, "");
  return page.locales.map((locale, i) => {
    const path = `${i === 0 ? "" : `/${locale}`}${rest}`;
    return { locale, path: ownHost ? path || "/" : prefix + path };
  });
}
