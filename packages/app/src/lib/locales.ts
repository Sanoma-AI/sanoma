import { useRouterState } from "@tanstack/react-router";
import LOCALES from "virtual:sanoma/locales";

// A public site's languages (`defineSite({ locales })`), as its pages' URLs say them: a site puts
// its pages under `routes/{-$locale}/`, TanStack's optional path parameter, so `/about` is in its
// default language and `/fr/about` in French, on its own host as under `/sites/<name>` on the
// app's. The languages come from `site.ts` through the build (`virtual:sanoma/locales`), so the
// public host loads no other site's `site.ts`. The root route reads them once per navigation
// (`pageLanguages`); browser and server alike.

/** The site a route path is in (`/sites/<name>…`), by its folder's name. */
export const siteOf = (path: string | undefined): string | undefined =>
  path === undefined ? undefined : /^\/sites\/([^/]+)/.exec(path)?.[1];

/** A route match, as much of it as says its language and its URL in another. */
export interface LocaleMatch {
  /** Its path as the router declares it, groups and pathless layouts left out: `/sites/<name>/{-$locale}/about`. */
  fullPath: string;
  params: Record<string, unknown>;
}

/** The page on screen in its site's languages: what the root route's `beforeLoad` puts in its context. */
export interface PageLanguages {
  /** The page's language: the URL's, else its site's default; none when its site has no languages. */
  locale?: string;
  /** The page in each of its site's languages, the default first, `href` on this host; none when it is not under `{-$locale}`. */
  locales: { locale: string; href: string }[];
}

/**
 * The page `leaf` (the deepest match) in its site's languages, its URL in each made by `href`
 * (the router's `buildLocation`, so the host's rewrite applies); `notFound` when the URL names a
 * language the site does not have (as written: the router matches `/pt-br/` too), or its default,
 * which has no prefix.
 */
export function pageLanguages(
  leaf: LocaleMatch | undefined,
  href: (to: string, params: Record<string, unknown>) => string,
): PageLanguages | "notFound" {
  const site = siteOf(leaf?.fullPath);
  if (!leaf || !site) return { locales: [] };
  const locales = Object.hasOwn(LOCALES, site) ? LOCALES[site] : undefined;
  if (!leaf.fullPath.startsWith(`/sites/${site}/{-$locale}`)) return { locale: locales?.[0], locales: [] };
  // A site with no languages (or a problem in them) has no URL in one.
  const named = leaf.params.locale;
  if (named !== undefined && (!locales || named === locales[0] || !locales.includes(named as string)))
    return "notFound";
  if (!locales) return { locales: [] };
  return {
    locale: (named as string | undefined) ?? locales[0],
    locales: locales.map((locale, i) => ({
      locale,
      href: href(leaf.fullPath, { ...leaf.params, locale: i === 0 ? undefined : locale }),
    })),
  };
}

/** The page on screen in its site's languages, as the root route's `beforeLoad` found them. */
export const usePageLanguages = (): PageLanguages =>
  useRouterState({
    select: ({ matches }) => {
      const { locale, locales = [] } = (matches[0]?.context ?? {}) as Partial<PageLanguages>;
      return { locale, locales };
    },
    structuralSharing: true,
  });
