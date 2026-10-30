// What an app's `app.ts` and a site's `site.ts` declare themselves with. Dependency-free: the
// loader (`load.ts`) serves these to those files as `sanoma` and `sanoma/site`, the browser-safe
// entry (`shared.ts`) re-exports `defineSite`, and the app's `sanoma/site` calls it.

/** What `app.ts` declares: the source repository's URL, when the app was taken from one. */
export interface AppDefinition {
  source?: string;
}

/**
 * Declares an app in its folder's `app.ts`, its default export: `defineApp({ source:
 * "https://github.com/acme/crm" })`, the repository it was taken from; `defineApp({})` for an app
 * the company made itself.
 */
export function defineApp(definition: AppDefinition): AppDefinition {
  return Object.freeze({ ...definition });
}

/** What a site's `site.ts` declares, as its default export; the app's `sanoma/site` types `icon` as a Lucide icon's name. */
export interface SiteDefinition {
  title?: string;
  icon?: string;
  public?: boolean;
  login?: string;
  locales?: readonly [string, ...string[]];
}

/** Declares a site in its folder's `site.ts`, its default export: `defineSite({ title: "Help desk" })`. */
export function defineSite<S extends SiteDefinition>(site: S): Readonly<S> {
  return Object.freeze({ ...site });
}
