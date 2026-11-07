import { describe, expect, it } from "vitest";
import { sitemapEntries, sitemapXml } from "../src/seo.ts";

// A public site's sitemap from its pages and published content, without a build.

const origin = "https://sanoma.example";

describe("sitemapEntries", () => {
  it("lists a translation alone only in its language, and a page with a parameter no content fills nowhere", () => {
    const site = {
      name: "www",
      locales: ["en", "fr"],
      pages: [
        { path: "/sites/www/{-$locale}/blog/$slug", content: "posts" },
        { path: "/sites/www/{-$locale}/tags/$tag" },
        { path: "/sites/www/about" },
      ],
    };
    const entries = sitemapEntries(site, origin, { posts: [{ slug: "only-fr", locale: "fr" }] });
    expect(entries).toEqual([
      { loc: `${origin}/fr/blog/only-fr`, alternates: [] },
      { loc: `${origin}/about`, alternates: [] },
    ]);
  });

  it("lists an entry with a translation in each language, each with its URL in both and the default's as x-default", () => {
    const site = {
      name: "www",
      locales: ["en", "fr"],
      pages: [{ path: "/sites/www/{-$locale}/blog/$slug", content: "posts" }],
    };
    const alternates = [
      { locale: "en", href: `${origin}/blog/hello` },
      { locale: "fr", href: `${origin}/fr/blog/hello` },
      { locale: "x-default", href: `${origin}/blog/hello` },
    ];
    expect(sitemapEntries(site, origin, { posts: [{ slug: "hello" }, { slug: "hello", locale: "fr" }] })).toEqual([
      { loc: `${origin}/blog/hello`, alternates },
      { loc: `${origin}/fr/blog/hello`, alternates },
    ]);
  });

  it("lists a page with no languages only for the entries its get(slug) finds, a translation alone not among them", () => {
    const site = { name: "www", pages: [{ path: "/sites/www/blog/$slug", content: "posts" }] };
    const published = { posts: [{ slug: "hello" }, { slug: "only-fr", locale: "fr" }] };
    expect(sitemapEntries(site, origin, published)).toEqual([{ loc: `${origin}/blog/hello`, alternates: [] }]);
  });

  it("treats {-$locale} as no parameter on a site with no languages", () => {
    const site = { name: "www", pages: [{ path: "/sites/www/{-$locale}" }] };
    expect(sitemapEntries(site, origin, {})).toEqual([{ loc: `${origin}/`, alternates: [] }]);
  });

  it("leaves out a page that keeps out of the sitemap, with every entry of its kind", () => {
    const site = {
      name: "www",
      pages: [
        { path: "/sites/www/about" },
        { path: "/sites/www/blog/$slug", content: "posts", sitemap: false as const },
        { path: "/sites/www/start", sitemap: false as const },
      ],
    };
    expect(sitemapEntries(site, origin, { posts: [{ slug: "hello" }] })).toEqual([
      { loc: `${origin}/about`, alternates: [] },
    ]);
  });

  it("escapes what it writes", () => {
    expect(sitemapXml([{ loc: `${origin}/?a=1&b=2`, alternates: [] }])).toContain(`<loc>${origin}/?a=1&#38;b=2</loc>`);
  });
});
