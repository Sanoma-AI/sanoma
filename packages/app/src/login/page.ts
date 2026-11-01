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
