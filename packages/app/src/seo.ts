// A public site's robots.txt and sitemap.xml, Node only: what `startApp` answers on the site's own
// host for those two paths, ahead of its pages.
import type { SiteEntry } from "@sanoma-ai/workflows/describe";
import type { Published } from "./content-files.ts";
import { escapeHtml } from "./login/page.ts";
import { inLocale } from "./content-types.ts";
import { alternatesOf, hasOneUrl, isLocalized, LOCALE_SEGMENT, sitePath, withoutOptional } from "./site-path.ts";

/**
 * `/robots.txt` and `/sitemap.xml` on a public site's own host at `origin`, for a GET or HEAD;
 * undefined for any other request. The sitemap lists the entries `published` gives.
 */
export function seoFile(
  request: Request,
  site: Pick<SiteEntry, "name" | "pages" | "locales">,
  origin: string,
  published: () => Published,
): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const file = (body: string, type: string) =>
    new Response(request.method === "HEAD" ? null : body, {
      headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" },
    });
  const { pathname } = new URL(request.url);
  if (pathname === "/robots.txt") return file(robotsTxt(origin), "text/plain");
  if (pathname === "/sitemap.xml")
    return file(sitemapXml(sitemapEntries(site, origin, published())), "application/xml");
  return undefined;
}

/**
 * robots.txt: every crawler may read everything, and where the sitemap is. A host that is not the
 * site's domain says `noindex` on every response instead (`startApp`), which a crawler sees only
 * when robots.txt lets it read the page.
 */
export const robotsTxt = (origin: string): string => `User-agent: *\nDisallow:\n\nSitemap: ${origin}/sitemap.xml\n`;

/** A page in a sitemap: its URL, and its URL in each language it is in (`hreflang`), with `x-default`. */
export interface SitemapEntry {
  loc: string;
  alternates: { locale: string; href: string }[];
}

/**
 * The site's pages at `origin`, by path (`SiteEntry.pages`): each page with no parameter, and for a
 * page whose one parameter a content kind fills (`SitePage.content`), one per published entry of
 * that kind. A page under `{-$locale}` is there once per language of the site (`locales`, the
 * default unprefixed), each with its URL in every language it is in and `x-default`: a content page
 * in the languages its entry is in as the page reads it, `content.<kind>.get(slug, { locale })`
 * with the URL's `params.locale` (`inLocale`; the default's URL names none).
 */
export function sitemapEntries(
  site: Pick<SiteEntry, "name" | "pages" | "locales">,
  origin: string,
  published: Published,
): SitemapEntry[] {
  return site.pages.flatMap(({ path, content }) => {
    const locales = site.locales?.length && isLocalized(site.name, path) ? site.locales : [];
    // The URL's `params.locale` in each of the page's languages, the default's none; one, none, without.
    const params = locales.length ? locales.map((locale, i) => (i === 0 ? undefined : locale)) : [undefined];
    const url = (slug: string | undefined, param: string | undefined) => {
      let page = withoutOptional(param === undefined ? path : path.replace(LOCALE_SEGMENT, `/${param}`));
      if (slug !== undefined) page = page.replace(/\$[^/]+/, slug);
      return new URL(sitePath(site.name, page), origin).href;
    };
    const entries = content === undefined ? undefined : (published[content] ?? []);
    const slugs = entries ? [...new Set(entries.map(({ slug }) => slug))] : hasOneUrl(path) ? [undefined] : [];
    // The slugs the page finds in each language: every one for a page that reads no content.
    const slugsIn = params.map((param) => entries && new Set(inLocale(entries, param).map(({ slug }) => slug)));
    return slugs.flatMap((slug) => {
      const found = params.flatMap((param, i) =>
        slug === undefined || slugsIn[i]!.has(slug) ? [{ locale: locales[i]!, href: url(slug, param) }] : [],
      );
      const alternates = alternatesOf(found, locales[0]);
      return found.map(({ href }) => ({ loc: href, alternates }));
    });
  });
}

/** A sitemap of `entries` (sitemaps.org's protocol, with `xhtml:link` for each page's languages). */
export const sitemapXml = (entries: readonly SitemapEntry[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries
    .map(
      ({ loc, alternates }) =>
        `  <url><loc>${escapeHtml(loc)}</loc>${alternates
          .map(
            ({ locale, href }) =>
              `<xhtml:link rel="alternate" hreflang="${escapeHtml(locale)}" href="${escapeHtml(href)}"/>`,
          )
          .join("")}</url>\n`,
    )
    .join("")}</urlset>\n`;
