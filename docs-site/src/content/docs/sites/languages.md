---
title: Languages
description: "A public site with no login can be in more than one language."
sidebar:
  order: 9
---

A public site with no login can be in more than one language. Its `site.ts` names them, the first its default, and its pages go under `routes/{-$locale}/`, TanStack Router's optional path parameter: the default language at `/about`, each other at `/<locale>/about`, on the site's own host and under `/sites/<name>/` on the app's.

```ts
// sites/www/site.ts
export default defineSite({ title: "Website", public: true, locales: ["en", "fr"] });

// sites/www/messages.ts: the site's own strings, typed by the default's
import { defineMessages } from "sanoma/site";
import site from "./site.ts";

export const messages = defineMessages(site, {
  en: { blog: "Blog", read: (title: string) => `Read “${title}”` },
  fr: { blog: "Blog", read: (title: string) => `Lire « ${title} »` },
});
```

```tsx
// sites/www/routes/{-$locale}/blog.index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { content, Link, useMessages } from "sanoma/site";
import { messages } from "../../messages.ts";

export const Route = createFileRoute("/sites/www/{-$locale}/blog/")({
  loader: ({ params }) => content.posts.list({ locale: params.locale }),
  head: ({ params }) => ({ meta: [{ title: messages.get(params.locale).blog }] }),
  component: Blog,
});

function Blog() {
  const t = useMessages(messages);
  return Route.useLoaderData().map((post) => (
    <Link key={post.slug} to="/sites/www/{-$locale}/blog/$slug" params={{ slug: post.slug }}>
      {t.read(post.data.title)}
    </Link>
  ));
}
```

## How languages work

- **URLs.** `params.locale` is the URL's language, `undefined` in the default's. A `Link` keeps the page's language (the router carries `locale` over); `params={{ locale: "fr" }}` names another. A language the site lacks, and the default's own prefix (`/en/…`), are not found. A page outside `{-$locale}` has one URL, in the default language.
- **Strings.** `defineMessages(site, { <locale>: { … } })` takes every language of the site, each with exactly the default's keys and types, so a key or a language missing or extra fails `sanoma check`; a string with values in it is a function of them, its parameters typed in each language. `useMessages(messages)` gives the strings of the page on screen, `messages.get(params.locale)` those of a language in a loader or a `head`.
- **The page.** On the site's own host, `<html lang>` is the page's language (`useLocale()` gives it, for `Intl`'s formats, on either host; the app's host keeps `en`, its chrome's), and each page under `{-$locale}` in more than one language links to itself in each, `<link rel="alternate" hreflang>` with absolute URLs at `siteOrigin()` (the site's domain when it has one), and to its default as `x-default` when it is in that; the [sitemap](/sites/public-sites/) lists it once per language with the same alternates. A page is in every language, but a content page (one the sitemap lists per entry) only in those its entry is in, as its loader reads it: a post with no translation shows its original under each prefix, and a translation alone (`only.fr.md`, no `only.md`) is in French only.
- **A switcher** is the site's own component: `useLocales()` gives the page on screen in each language it is in, `{ locale, href, current }`, in the site's order, `href` its path on this host.

```tsx
export function Switcher() {
  return useLocales().map(({ locale, href, current }) => (
    <a key={locale} href={href} hrefLang={locale} aria-current={current ? "page" : undefined}>
      {locale}
    </a>
  ));
}
```

## Related and later

- **Content:** a post's translation is `<slug>.<locale>.md` ([Content](/sites/content/)).
- **In the app:** the Sites page lists a site's languages, its default first.
- **Later:** a visitor's language from `Accept-Language` or a cookie, redirected to; `sanoma check` naming a translation in a language no site has; translated path segments (`/fr/a-propos`); languages on a site with a login; the app's own screens in another language.
