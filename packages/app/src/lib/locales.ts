import { trimPathRight, useRouterState } from "@tanstack/react-router";
import LOCALES, { contentPages } from "virtual:sanoma/locales";
import { content, type UntypedContent } from "../content.ts";
import type { ContentKind } from "../content-types.ts";
import { isLocalized, withoutOptional } from "../site-path.ts";

// A public site's languages (`defineSite({ locales })`), as its pages' URLs say them: a site puts
// its pages under `routes/{-$locale}/`, TanStack's optional path parameter, so `/about` is in its
// default language and `/fr/about` in French, on its own host as under `/sites/<name>` on the
// app's. The languages come from `site.ts` through the build (`virtual:sanoma/locales`), so the
// public host loads no other site's `site.ts`. The root route reads them once per navigation
// (`pageLanguages`); browser and server alike.

/** Site `site`'s languages (`defineSite({ locales })`), its default first; none for a site with none. */
const localesOf = (site: string | undefined): string[] | undefined =>
  site !== undefined && Object.hasOwn(LOCALES, site) ? LOCALES[site] : undefined;

/** Site `site`'s default language, the first of its `locales`; none for a site with none. */
export const defaultLocaleOf = (site: string | undefined): string | undefined => localesOf(site)?.[0];

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
  /**
   * The page in each of its site's languages it is in, in the site's order, `href` on this host;
   * none when it is not under `{-$locale}`. A content page is in those its entry is in (`languagesOf`).
   */
  locales: { locale: string; href: string }[];
}

/**
 * The page `leaf` (the deepest match) in its site's languages, its URL in each made by `href`
 * (the router's `buildLocation`, so the host's rewrite applies); `notFound` when the URL names a
 * language the site does not have (as written: the router matches `/pt-br/` too), or its default,
 * which has no prefix.
 */
export async function pageLanguages(
  leaf: LocaleMatch | undefined,
  href: (to: string, params: Record<string, unknown>) => string,
): Promise<PageLanguages | "notFound"> {
  const site = siteOf(leaf?.fullPath);
  if (!leaf || !site) return { locales: [] };
  const locales = localesOf(site);
  if (!isLocalized(site, leaf.fullPath)) return { locale: locales?.[0], locales: [] };
  // A site with no languages (or a problem in them) has no URL in one.
  const named = leaf.params.locale;
  if (named !== undefined && (!locales || named === locales[0] || !locales.includes(named as string)))
    return "notFound";
  if (!locales) return { locales: [] };
  const found = await languagesOf(leaf, locales);
  return {
    locale: (named as string | undefined) ?? locales[0],
    locales: locales.flatMap((locale, i) =>
      found[i] ? [{ locale, href: href(leaf.fullPath, { ...leaf.params, locale: i === 0 ? undefined : locale }) }] : [],
    ),
  };
}

/**
 * Whether the page `leaf` is in each of `locales`: a page whose entries are a content kind's
 * (`contentPages`, as the sitemap reads them) where its entry is, as its loader reads it,
 * `content.<kind>.get(slug, { locale: params.locale })` (`inLocale`; the default's URL names
 * none); any other page in every one.
 */
async function languagesOf(leaf: LocaleMatch, locales: string[]): Promise<boolean[]> {
  const path = trimPathRight(leaf.fullPath);
  const kind = Object.hasOwn(contentPages, path) ? contentPages[path] : undefined;
  const param = /\$([^/]+)/.exec(withoutOptional(path))?.[1];
  const slug = param === undefined ? undefined : leaf.params[param];
  if (kind === undefined || typeof slug !== "string") return locales.map(() => true);
  // Any kind, by name: a company's `content` types only its own.
  const entries: ContentKind<unknown> = (content as UntypedContent)[kind];
  return Promise.all(
    locales.map(async (locale, i) => (await entries.get(slug, { locale: i === 0 ? undefined : locale })) !== undefined),
  );
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
