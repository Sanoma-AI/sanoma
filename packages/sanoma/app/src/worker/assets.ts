// The Worker's static assets (`AppBundleEnv.ASSETS`), as both the main module and the app answer
// from them: the main module a page prerendered for a public site's domain, before the app is
// loaded; the app a file of the client build or of a site's public files, after the login.
import type { AppBundleEnv } from "../app-bundle.ts";

/** The asset at `path`, for `request` (its method and headers); undefined when the assets have none. */
export async function assetAt(request: Request, env: AppBundleEnv, path: string): Promise<Response | undefined> {
  const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));
  if (asset.ok) return asset;
  await asset.body?.cancel();
  return undefined;
}
