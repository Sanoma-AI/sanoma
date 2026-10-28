/** Where a link opened from a company's window goes: that window, the default browser, or nowhere. */
export type LinkTarget = "window" | "browser" | "deny";

/**
 * The link rule. In the window: the app's own origin, its public sites (`<name>.localhost` on the
 * app's port) and GitHub (the GitHub App manifest round trip needs the window's cookies on both
 * ends). Any other web or mail link goes to the default browser; anything else (a `file:` URL, a
 * custom scheme) goes nowhere.
 */
export function linkTarget(link: string, appUrl: string): LinkTarget {
  let url: URL;
  let app: URL;
  try {
    url = new URL(link);
    app = new URL(appUrl);
  } catch {
    return "deny";
  }
  if (isAppPage(link, appUrl)) return "window";
  if (url.protocol === app.protocol && url.port === app.port && url.hostname.endsWith(".localhost")) return "window";
  if (url.protocol === "https:" && url.host === "github.com") return "window";
  return ["http:", "https:", "mailto:"].includes(url.protocol) ? "browser" : "deny";
}

/**
 * Whether `page` is the app's own, at `appUrl`'s origin: the one page the shell's companies API
 * (`app-preload.ts`) answers, never GitHub's or a public site's, which the window may show too.
 */
export function isAppPage(page: string, appUrl: string): boolean {
  try {
    return new URL(page).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
