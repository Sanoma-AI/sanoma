// The app bundle's contract (`buildAppBundle` in `@sanoma-ai/app/bundle`): what the build hands a
// host to upload, what the bundle's main module expects of its environment, what it asks of the
// host, and where its prerendered pages are. Nothing of the app's, so a host (the Cloudflare
// connector) reads it from `@sanoma-ai/app` without loading the app.

/** What the Worker runs the app from: the main module and its modules, the static assets, the runtime it was built for. */
export interface AppBundle {
  /** The company's applicationVersion it was built from (`AppSnapshot.version`): the version its runs are enqueued with. */
  version: string;
  /** The main module, among `modules`: its default export is `AppBundleModule`. */
  mainModule: string;
  /** The Worker's modules, by name relative to the main module, each base64. */
  modules: { name: string; type: "esm" | "wasm" | "text" | "data"; content: string }[];
  /**
   * The static assets, by path from `/`, each base64, with Cloudflare's asset hash (the first 32
   * hex digits of the SHA-256 of the base64 and the extension) and its size in bytes: the client
   * build, a site's public files and the prerendered pages (`prerendered`).
   */
  assets: { path: string; content: string; hash: string; size: number }[];
  /** The Worker's compatibility date and flags, as built and tested (`nodejs_compat`). */
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** The pages prerendered among the assets: a public site's page at `path` on its `domain`, the file `asset`. */
  prerendered: { site: string; domain: string; path: string; asset: string }[];
}

/** What the bundle's main module reads of the Worker's bindings. */
export interface AppBundleEnv {
  /** The company's database: a Hyperdrive binding, or anything with its connection string. */
  DATABASE: { connectionString: string };
  /**
   * The app's own hostname: the staff's pages are served there, and a public site's on its domain
   * (`SANOMA_DOMAINS`); a request for any other host answers 404. Unset, every host that is no
   * site's domain is the app's.
   */
  SANOMA_HOSTNAME?: string;
  /** `<site>=<hostname>,…`: the public sites' domains (`domainsText`). */
  SANOMA_DOMAINS?: string;
  /** The deployment's signing key, each login's key derived from it (`deploymentKey`). */
  SANOMA_SIGNING_KEY?: string;
  /** The key the stored secrets are sealed under, when the config stores them itself. */
  SANOMA_SECRETS_KEY?: string;
  /** The Worker's static assets: `AppBundle.assets`. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** What the Worker's request gives the bundle to keep working after the response. */
export interface AppBundleContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What the host gives the bundle: the worker that runs the company's runs. */
export interface AppHost {
  /** Starts the worker now, without waiting for it: a run was queued for it. */
  startNow(): Promise<unknown>;
}

/** The main module's default export: the app's fetch handler. Without a `host`, a queued run waits for whatever starts the worker. */
export interface AppBundleModule {
  fetch(request: Request, env: AppBundleEnv, ctx: AppBundleContext, host?: AppHost): Promise<Response>;
}

/** Where a public site's page at `pathname` on `domain` is prerendered among the assets; undefined for a path with a trailing slash, which the router redirects. */
export function prerenderedAsset(domain: string, pathname: string): string | undefined {
  if (pathname !== "/" && pathname.endsWith("/")) return undefined;
  return `${PRERENDERED}/${domain}${pathname === "/" ? "" : pathname}/index.html`;
}

/** The assets' folder of the prerendered pages, one folder per domain. */
export const PRERENDERED = "/__sanoma/pages";
