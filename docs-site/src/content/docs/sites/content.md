---
title: Content
description: "content, from sanoma/site, is the Markdown under the company repo's content/, as of the build."
sidebar:
  order: 7
---

`content`, from `sanoma/site`, is the Markdown under the company repo's `content/`, as of the build: each folder directly under `content/` is a kind, and each `*.md` directly in it an entry, its slug the file's name. Both names are URL segments (`/^[a-z][a-z0-9-]*$/`); subfolders, `.mdx` and other files are left alone. A post, `content/posts/zapier-and-sanoma.md`, and the page that shows it:

```md
---
title: Zapier and Sanoma
description: How they differ.
publishedAt: 2026-10-01
---

What a visitor reads, in **Markdown** (GFM: tables, task lists, strikethrough).
```

```tsx
// sites/www/routes/blog.$slug.tsx
import { createFileRoute } from "@tanstack/react-router";
import { content, notFound } from "sanoma/site";
import { NotFound } from "../components/not-found.tsx";

export const Route = createFileRoute("/sites/www/blog/$slug")({
  loader: async ({ params }) => {
    const post = await content.posts.get(params.slug);
    if (!post) throw notFound();
    return post;
  },
  // Not found, it gives no title: the app's "Page not found" stays.
  head: ({ loaderData }) => ({ meta: loaderData ? [{ title: loaderData.data.title }] : [] }),
  component: Post,
  // Drawn here, inside the site's layout.
  notFoundComponent: NotFound,
});

function Post() {
  const post = Route.useLoaderData();
  return <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />;
}
```

| Call                            | What it gives                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content.posts.list()`          | Every file of `content/posts/`, sorted by slug, as `{ slug, data }`: `data` is the front matter (`{}` with none)                                                   |
| `content.posts.get(slug)`       | One file, `{ slug, data, body, html }`: `body` the Markdown after the front matter as written, `html` it rendered at build; `undefined` when there is no such file |
| `content.<kind>` with no folder | `list()` gives `[]` and `get()` `undefined`; once `.sanoma/content.ts` types `content`, it does not type-check                                                     |

- **Translations:** `content/posts/hello.fr.md` is `hello` in French, beside `hello.md`, the site's default language's. Its front matter is laid over the original's, so what it does not repeat (a date, an image, `draft`) is the original's: a draft's translation is a draft unless it says `draft: false`. A translation with front matter alone keeps the original's body. `list({ locale })` and `get(slug, { locale })` give each slug's file in that language, else its `<slug>.md` (an entry's `locale` says which: absent for `<slug>.md`); without `locale`, `<slug>.md` alone, as before translations. A language is a tag such as `fr` or `pt-BR` ([Languages](/sites/languages/)).

- **Not found:** a loader's `notFound()` is drawn by the nearest route, from the page up, with a `notFoundComponent`, in place of that route: give the page one, as above, and the site's layout one too (`sites/www/routes/route.tsx`), which draws a path no page has inside the layout. A page whose route has none draws in the layout's place when the layout has one, and, with neither, the app's not-found notice takes the page's place (on a public site's own host, [a plain page](/sites/public-sites/)). Its head runs with no `loaderData`.
- **Front matter** is YAML between a first line `---` and the next `---` line, read as YAML 1.2, so an unquoted date stays a string. A file whose front matter is not a mapping is left out, and `sanoma check` reports it at its line.
- **HTML** is rendered at build with `marked` (GFM), so no Markdown library ships to the browser. Raw HTML in a file passes through: content is reviewed as code is. The kit has no styles for it; give the `article` your own classes.
- **Drafts:** an entry whose front matter has `draft: true` is there while `sanoma` serves the sites from its dev server, and never in a build: not on a page, not in any file sent to the browser.
- **Loading:** the content is one chunk of the browser's bundle, loaded on the first call, and part of the server's render, so a loader's `await content.posts.list()` adds no request. A change under `content/` is a new build (the build's key covers it). On the dev server, a file saved under `content/` shows on the next render of an open page, with no restart.
- **Types:** `.sanoma/content.ts`, written with the sites' generated files (and again on the dev server when a file under `content/` changes), types `content` by augmenting `Register`, as `.sanoma/api.ts` types `api`: each kind's `data` is the union of its files' front matter, drafts included, a key in every file required and `?` otherwise; strings, numbers, booleans and `null` as themselves, a list as an array of its items' types, a mapping as an object merged the same way (so rows of a table in the front matter share one type). Values are never types: `status: draft` is a `string`. Until it is written, `content` is untyped.

`readContent(repo, { drafts })` and `contentTypes(kinds)`, from `sanoma/app/build`, are what the build and `sanoma check` read with: the kinds and the problems, each `{ file, line, column, message }`, and the text of `.sanoma/content.ts` (`CONTENT_TYPES`).
