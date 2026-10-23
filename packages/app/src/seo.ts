// A public site's robots.txt and sitemap.xml, Node only: what `startApp` answers on the site's own
// host for those two paths, ahead of its pages.
import type { SiteEntry } from "@sanoma-ai/workflows/describe";
import type { Published } from "./content-files.ts";
import { escapeHtml } from "./login/page.ts";
import { sitePath } from "./site-path.ts";

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
  alternates: { hreflang: string; href: string }[];
}

/**
 * The site's pages at `origin`, by path (`SiteEntry.pages`): each page with no parameter, and for a
 * page whose one parameter a content kind fills (`SitePage.content`), one per published entry of
 * that kind. A page under `{-$locale}` is there once per language of the site (`locales`, the
 * default unprefixed), each with its URL in every language it is in: a content page in a language
 * when its entry has a translation into it or a `<slug>.md` (the default's only the latter), as
 * `content.<kind>.get(slug, { locale })` reads it.
 */
export function sitemapEntries(
  site: Pick<SiteEntry, "name" | "pages" | "locales">,
  origin: string,
  published: Published,
): SitemapEntry[] {
  return site.pages.flatMap(({ path, content }) => {
    const localized = path.includes(LOCALE_SEGMENT);
    const locales = localized && site.locales?.length ? site.locales : [undefined];
    const url = (locale: string | undefined, slug?: string) => {
      let page = path.replace(LOCALE_SEGMENT, locale === undefined || locale === locales[0] ? "" : `/${locale}`);
      page = page.replace(/\/\{-\$[^}]*\}/g, "");
      if (slug !== undefined) page = page.replace(/\$[^/]+/, slug);
      return new URL(sitePath(site.name, page), origin).href;
    };
    // Each URL's slug, and the languages it is in.
    let pages: { slug?: string; in: (string | undefined)[] }[];
    if (content !== undefined) {
      const entries = published[content] ?? [];
      const slugs = [...new Set(entries.map(({ slug }) => slug))];
      pages = slugs.map((slug) => ({
        slug,
        in: locales.filter((locale, i) =>
          entries.some((e) => e.slug === slug && (e.locale === undefined || (i > 0 && e.locale === locale))),
        ),
      }));
    } else pages = path.replace(/\{-\$[^}]*\}/g, "").includes("$") ? [] : [{ in: locales }];
    return pages.flatMap(({ slug, in: found }) => {
      const alternates =
        found.length > 1
          ? [
              ...found.map((locale) => ({ hreflang: locale!, href: url(locale, slug) })),
              ...(found[0] === locales[0] ? [{ hreflang: "x-default", href: url(locales[0], slug) }] : []),
            ]
          : [];
      return found.map((locale) => ({ loc: url(locale, slug), alternates }));
    });
  });
}

/** Where a site's pages take their language: TanStack's optional path parameter. */
const LOCALE_SEGMENT = "/{-$locale}";

/** A sitemap of `entries` (sitemaps.org's protocol, with `xhtml:link` for each page's languages). */
export const sitemapXml = (entries: readonly SitemapEntry[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries
    .map(
      ({ loc, alternates }) =>
        `  <url><loc>${escapeHtml(loc)}</loc>${alternates
          .map(
            ({ hreflang, href }) =>
              `<xhtml:link rel="alternate" hreflang="${escapeHtml(hreflang)}" href="${escapeHtml(href)}"/>`,
          )
          .join("")}</url>\n`,
    )
    .join("")}</urlset>\n`;
