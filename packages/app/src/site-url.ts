import { trimPathRight } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { sitePath } from "./site-path.ts";

// Where the page is: the public site whose host it is on, and the origin its absolute URLs take.
// Browser code, beside `site.ts`: on the server it reads Start's request context, in the browser
// what the root wrote on `<html>`, never the URL's host, which a proxy may change.

/**
 * The page's site and origin: on the server, what `startApp` put in the request's context (the
 * public site whose host it came to, and its origin: the site's domain, else the request's own);
 * in the browser, what the server wrote on `<html data-site data-origin>`. Neither outside a request.
 */
export const pageHost = createIsomorphicFn()
  .server((): { site?: string; origin?: string } => {
    // Start makes a router outside the request's context only to follow a server function's
    // redirect, which then resolves as on the app's host.
    try {
      const context = getGlobalStartContext();
      return { site: context?.site, origin: context?.origin };
    } catch {
      return {};
    }
  })
  .client(() => {
    const { site, origin } = document.documentElement.dataset;
    return { site: site || undefined, origin: origin || location.origin };
  });

/**
 * This page's origin, for an absolute URL a crawler needs: on a public site's own host, the site's
 * domain when it has one, else the host the request came to; on the app's host, the app's. For a
 * built file, `new URL(og, siteOrigin()).href` (`import og from "../assets/og.png"`). In a route's
 * `head`, its loader or a component.
 */
export const siteOrigin = (): string => originOf(pageHost());

/**
 * The absolute URL of a page, for a canonical link or `og:url`, from its path as the route tree
 * spells it (`match.pathname` in a `head`, `/sites/www/blog/hello`): at `siteOrigin()`, and on a
 * public site's own host without `/sites/<name>`, as its links are; without a trailing slash but
 * on `/`, as the router answers it and the sitemap lists it.
 */
export function siteUrl(path: string): string {
  const host = pageHost();
  const page = trimPathRight(path);
  return new URL(host.site === undefined ? page : sitePath(host.site, page), originOf(host)).href;
}

function originOf({ origin }: { origin?: string }): string {
  if (origin === undefined) throw new Error("siteOrigin() and siteUrl() are for a page: its head, loader or component");
  return origin;
}
