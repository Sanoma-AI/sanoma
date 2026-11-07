// The app bundle's main module (`buildAppBundle`): the app's fetch handler for the Worker
// (`AppBundleModule`). A page prerendered for a public site's domain is answered from the assets
// without the app; anything else imports the app, on the first request that needs it, so the
// isolate starts with this module alone; the app's route chunks load as their pages are asked for.
import { domains } from "virtual:sanoma/prerendered";
import {
  type AppBundleContext,
  type AppBundleEnv,
  type AppBundleModule,
  type AppHost,
  prerenderedAsset,
} from "../app-bundle.ts";
import { assetAt } from "./assets.ts";

let app: Promise<typeof import("./app.ts")> | undefined;

/** The domains with a page prerendered: a page asked for on another host is never looked for among the assets. */
const prerendered = new Set(domains);

/**
 * A GET's or HEAD's page prerendered for its domain, unless a query, which the page may read, asks
 * otherwise, or the path has an extension (a file, the app's). Undefined when the assets have none:
 * a page a call is made from, rendered by the app.
 */
async function prerenderedPage(request: Request, env: AppBundleEnv): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (url.search || !prerendered.has(url.hostname) || /\.[^/]+$/.test(url.pathname)) return undefined;
  const path = prerenderedAsset(url.hostname, url.pathname);
  return path === undefined ? undefined : assetAt(request, env, path);
}

export default {
  async fetch(request: Request, env: AppBundleEnv, ctx: AppBundleContext, host?: AppHost) {
    return (await prerenderedPage(request, env)) ?? (await (app ??= import("./app.ts"))).serve(request, env, ctx, host);
  },
} satisfies AppBundleModule;
