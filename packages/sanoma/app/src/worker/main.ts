// The app bundle's main module (`buildAppBundle`): the app's fetch handler for the Worker
// (`AppBundleModule`). A page prerendered for a public site's domain is answered from the assets
// without the app; anything else imports the app, on the first request that needs it, so the
// isolate starts with this module alone; the app's route chunks load as their pages are asked for.
import { pages } from "virtual:sanoma/prerendered";
import {
  type AppBundleContext,
  type AppBundleEnv,
  type AppBundleModule,
  type AppHost,
  prerenderedAsset,
} from "../app-bundle.ts";
import { assetAt } from "./assets.ts";

let app: Promise<typeof import("./app.ts")> | undefined;

/** The pages prerendered, by their assets' paths: any other request is the app's, never looked for among the assets. */
const prerendered = new Set(pages);

/** A GET's or HEAD's page prerendered for its domain, unless a query, which the page may read, asks otherwise. */
async function prerenderedPage(request: Request, env: AppBundleEnv): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  const path = url.search ? undefined : prerenderedAsset(url.hostname, url.pathname);
  return path !== undefined && prerendered.has(path) ? assetAt(request, env, path) : undefined;
}

export default {
  async fetch(request: Request, env: AppBundleEnv, ctx: AppBundleContext, host?: AppHost) {
    return (await prerenderedPage(request, env)) ?? (await (app ??= import("./app.ts"))).serve(request, env, ctx, host);
  },
} satisfies AppBundleModule;
