---
title: Public sites
description: "Serve a site on its own domain and control visitor routing, login, and search indexing."
sidebar:
  order: 8
---

Set `public: true` in `defineSite({ public: true })` to serve a site at the root of its own host. Visitors see the site there. Staff can open the same site at `/sites/<name>` on the app’s host, inside the company app.

## Hosts and routing

- **Its hosts.** `<name>.localhost` on the app's port (a browser sends `*.localhost` to this machine, and the loopback login lets it through), and the domain `startApp`'s `domains` gives it (`{ www: "sanoma.example" }`; the `sanoma` bin reads `SANOMA_DOMAINS`, which a host resource's `domains` sets). A domain naming a site that is missing or not public is warned about and served nowhere.

  `app.sites` gives each public site served, by name, at `http://<name>.localhost:<port>`; the Sites page links to the site's domain, else, on a page of this machine, to `<name>.localhost` (the server, which cannot know that address, says Public until the browser does).

- **One build, two routings.** On the site's host the router mounts the site at `/`: a page's `<Link to="/sites/www/blog">` is `/blog` there and `/sites/www/blog` on the app's host, and a path outside the site, `/workflows` among them, is the site's not-found page, a 404. A GET or HEAD there for a path under `/sites/<name>`, the site's page as the app's host spells it (a link copied from there), answers 308 to its path at the root, the query kept.

  The document there is bare: charset, viewport, a body with no margin, in a layer ahead of the site's stylesheet so any rule of the site's overrides it, the browser's light scheme (a site whose colours follow the visitor's light or dark, with `light-dark()`, says so in its stylesheet, as above: `[data-site="www"] { color-scheme: light dark; }`, not `:root`, which inside the app would override the app's own), and `<html data-site="<name>">`, which a site's stylesheet may scope its own host's rules to ([A site's own stylesheet](/sites/stylesheet/)); no app stylesheet, theme, icon, chrome or config, which the app's host loads in chunks of their own.

  The site's layout sets its own icon and stylesheet in its `head`, and each page its title; the kit's look comes with that stylesheet ([The kit on a site](/sites/stylesheet/#the-kit-on-a-site)).

## Not found, errors and login

- **Not found and errors.** A page not found there, a path no page has or a loader's `notFound()` ([Content](/sites/content/)), answers 404, titled "Page not found" unless a route of the site gives a title: a title in the layout's `head` stays on every page, a page not found too, so give each page its own. Where the site draws no `notFoundComponent` or `errorComponent`, the page is a plain one of the app's (a heading and a line, no app styles), and an error's message stays out of it.
- **Its front door.** A request to the site's host never reaches the staff login, and its cookie and `x-sanoma-actor` header are ignored there. The site's login (`defineSite({ public: true, login: "<connector>" })`, a connector's login half) answers `/auth/<connector>/*` and verifies a visitor, who acts as `visitor:<connector>:<subject>` in the group `visitors` (with the email and the GitHub login the login verified, as `ctx.startedBy.email` and `ctx.startedBy.github`, when it verified them); anyone else, and everyone on a site with no login, acts as `anonymous`.

  A request with `Authorization: Bearer sca_…`, an API token `SanomaClient.tokens.mint` made, acts as `token:<id>` in the groups the token was minted with, with no email; a token that is unknown or revoked is a 401. Only `callFn` (a site's `api`) and `getActor` (`useActor()`, which says nobody for `anonymous`) answer there: any other server function is not there (a change's 404, a read's not-found), nor any other `/auth/` route (404), and a method but GET, HEAD and POST is a 405.

  Every request there carries `x-sanoma-client-ip` (`CLIENT_IP_HEADER`), set from the socket, a client's own copy overwritten. What a visitor may call is the policy's, by a `permit` ([above](/sites/calling/)).

- **Visitor login.** Once it listens, `startApp` initializes the public site’s login provider before it resolves. An early request waits for initialization. The provider receives the client’s pool (`LoginContext.database`), stored secrets, and allowed origins (`http://<name>.localhost:*` and, when configured, `https://<domain>`). Its cookie-signing key is derived from `SANOMA_SIGNING_KEY` for `login <connector>`, so Better Auth needs no separate key.

  With `login.sender` configured, Better Auth supports email codes through `/auth/better-auth/email-otp/send-verification-otp` and `/auth/better-auth/sign-in/email-otp`. A `login-code` run sends the email. On a host, `sanoma` passes the company’s GitHub App client through `startApp`’s `social` option. Visitors can then sign up, sign in, or link their GitHub account using the same callback URL. See the [GitHub sign-in configuration](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/better-auth/README.md#github).

  A public site whose `site.ts` has a problem (its login may be one not read), or whose login fails to start, is served on no host, a 503, and the app's log says why; the app itself starts, so the connector's page, or `SANOMA_SIGNING_KEY` in the environment, can give what the login lacks.

## Search engines and absolute URLs

- **Search engines.** The site's host answers `/robots.txt` and `/sitemap.xml` itself, ahead of its pages (a site cannot replace them). robots.txt lets every crawler read everything and names the sitemap; on any host but the site's domain (`<name>.localhost`) every response says `X-Robots-Tag: noindex`, which a crawler sees because robots.txt lets it read the page.

  The sitemap lists the site's pages at its origin: each route file's path with no parameter (`describeConfig`'s `SiteEntry.pages`, read from the route ids without running them), and, for a path with one parameter whose file reads one kind's entry by it, `content.<kind>.get(params.slug)` (or `slug`, destructured), a page per entry of that kind (`/blog/$slug` gives `/blog/<slug>` for each post): the content as the app's snapshot read it (again once a file under `content/` changes; the Worker's, as built), drafts left out.

  A page whose file reads its entry some other way (through a component's helper) is left out: when the file reads content by something else than its parameter, `sanoma check` warns, naming it.

  A page whose route says `staticData: { sitemap: false }`, written out as that literal, is left out with all its entries: one whose `head` tells crawlers `noindex`, say. An index route's `sitemap`, when it gives one, decides over its layout's (`true` keeps the page in); a pathless or group layout's says nothing.

  A page under `{-$locale}` on a site with [languages](/sites/languages/) is listed once per language (the default unprefixed), with `xhtml:link` alternates to itself in each language it is in and `x-default`: a content page is in a language when its entry has a translation into it or a `<slug>.md`, as `content.<kind>.get(slug, { locale })` reads it. The Sites page links each public site's sitemap beside its address.

- **Absolute URLs.** A canonical link, `og:url` and `og:image` must be absolute. `siteOrigin()`, from `sanoma/site`, is the origin a page's URLs take: on a public site's host, its domain when it has one (`https://<domain>`), else the host the request came to; on the app's host, the app's.

  `siteUrl(path)` is a page's URL from its path as the route tree spells it, at that origin, without `/sites/<name>` on the site's host and without a trailing slash but on `/`, as the router answers it and the sitemap lists it (an index route's `match.pathname`, `/sites/www/blog/`, gives `/blog`). Both work in a route's `head`, its loader and a component, on the server and in the browser (`<html data-origin>`):

```tsx
// sites/www/routes/blog.$slug.tsx
import og from "../assets/og.png";

export const Route = createFileRoute("/sites/www/blog/$slug")({
 loader: …,
 head: ({ match, loaderData }) => ({
 meta: [
 { title: loaderData?.data.title },
 { property: "og:url", content: siteUrl(match.pathname) }, // https://sanoma.example/blog/<slug>
 { property: "og:image", content: new URL(og, siteOrigin()).href },
 ],
 links: [{ rel: "canonical", href: siteUrl(match.pathname) }],
 // JSON-LD, as TanStack's head allows: a script of type application/ld+json.
 scripts: [{ type: "application/ld+json", children: JSON.stringify({ "@context": "https://schema.org", "@type": "Article" }) }],
 }),
});
```

## Not on a public host, and later

- **Not on a public host:** the app's chrome and what it provides, so a site there brings its own toasts and has no `useDensity()` (it throws); `RunForm` and the will-ask preview, which read the config and link to the app's pages.
- **Later:** a `RunForm` on a public page; rate limits; `Cache-Control` headers on anonymous content pages, so a CDN in front can cache them (the cheap step toward prerendering), then prerendering on the other hosts, where an edge cache serves the files (on Cloudflare, `buildAppBundle` prerenders already; a content-only page's render reaches neither the database nor the worker, and Start's prerender cannot render with the request context a page needs); the public host's own pending view; an anonymous id per session (every anonymous visitor is one principal now).
