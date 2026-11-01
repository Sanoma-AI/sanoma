// What a login answers before the app's own pages: a small page of its own, or JSON for the page's
// server functions and any change.

/** Whether `request` wants JSON: the page's server functions and any change (not a GET or HEAD). */
export const wantsJson = (request: Request) =>
  new URL(request.url).pathname.startsWith("/_serverFn/") || (request.method !== "GET" && request.method !== "HEAD");

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small page of its own, `body` as HTML: the app's pages are for people signed in. */
export function smallPage(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)} · Sanoma</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A request's origin, https when a proxy that ends TLS says so (`x-forwarded-proto: https`), as
 * Start's `getRequestUrl({ xForwardedProto: true })` reads it: the absolute URLs a page or an invite writes take it.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  if (request.headers.get("x-forwarded-proto") === "https") url.protocol = "https:";
  return url.origin;
}

/** Whether a change comes from the app's own page: the browser says so, or its `Origin` names the request's host. */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = URL.parse(request.headers.get("origin") ?? "");
  return origin !== null && origin.host === request.headers.get("host");
}
