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

  it("treats {-$locale} as no parameter on a site with no languages", () => {
    const site = { name: "www", pages: [{ path: "/sites/www/{-$locale}" }] };
    expect(sitemapEntries(site, origin, {})).toEqual([{ loc: `${origin}/`, alternates: [] }]);
  });

  it("escapes what it writes", () => {
    expect(sitemapXml([{ loc: `${origin}/?a=1&b=2`, alternates: [] }])).toContain(`<loc>${origin}/?a=1&#38;b=2</loc>`);
  });
});
