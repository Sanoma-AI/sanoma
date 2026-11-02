import { createHash } from "node:crypto";
import { extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "@sanoma-ai/workflows";
import { SITES_BUNDLE_HEADER, SITES_BUNDLE_PATH, type SitesBundle } from "@sanoma-ai/workflows/shared";
import mime from "mime";
import { refused } from "./errors.ts";
import type { AssetFile, CloudflareApi, Upload } from "./ops.ts";
import { SITES_MODULE, sitesRouter } from "./worker.ts";

// The public sites on the company's Worker (sanoma#428): once a deploy's container answers at its
// revision, the sites bundle it built (`buildWorker` in `@sanoma-ai/app/build`) is downloaded from
// it with the instance token, its assets go in through an assets upload session, and the Worker is
// uploaded again with the bundle's modules under `sites/`, the router `worker/sites.js` as its
// entry and the assets bound as `ASSETS`. A page of a public site without a login then answers
// from the Worker, never waiting for the container; everything else goes to the object as before.

/** The binding the bundle reads its assets through (`WorkerEnv.ASSETS`). */
export const ASSETS = "ASSETS";

/**
 * How the Worker serves its assets: the client build under `/assets/` straight from them (a path
 * there they lack goes on to the Worker, as the app's own do), every other path through the
 * Worker first, which answers a prerendered page from them itself; never an HTML rewrite or a
 * fallback page of the assets' own.
 */
export const ASSETS_CONFIG = {
  html_handling: "none",
  not_found_handling: "none",
  run_worker_first: ["/*", "!/assets/*"],
} as const;

/** An asset's hash as a session's manifest names it: as the API reference's example has it, sha256 over its base64 and its extension, 32 hex digits. */
export const assetHash = (base64: string, path: string) =>
  createHash("sha256")
    .update(base64 + extname(path).slice(1))
    .digest("hex")
    .slice(0, 32);

interface Polling {
  /** How long the container may take to build the bundle. */
  startTimeoutMs: number;
  /** How long between two asks. */
  pollMs: number;
}

/**
 * The bundle the container at `url` built, asked with the instance token until it answers it
 * (202 while it builds, or the object's 503 while the container starts again); undefined when
 * it has no site to serve on the Worker (404), or the runtime has no such route (an answer
 * without `SITES_BUNDLE_HEADER`: an image from before it). A failed build, or a token it
 * refuses, is a refusal.
 */
export async function sitesBundle(
  cf: CloudflareApi,
  script: string,
  url: string,
  token: string,
  { startTimeoutMs, pollMs }: Polling,
): Promise<SitesBundle | undefined> {
  const until = Date.now() + startTimeoutMs;
  for (;;) {
    let last: string;
    try {
      const res = await cf.send(`${url}${SITES_BUNDLE_PATH}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      const route = res.headers.has(SITES_BUNDLE_HEADER);
      if (route && res.status === 200) return (await res.json()) as SitesBundle;
      const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
      const said = typeof body?.error === "string" ? body.error : `${SITES_BUNDLE_PATH} answered ${res.status}`;
      if (!route && res.status !== 503) return undefined;
      if (route && res.status === 404) return undefined;
      if (route && res.status !== 202) {
        throw refused(
          `${script}: its container did not give the sites bundle (its sites are served from the container meanwhile): ${said}`,
        );
      }
      last = route ? "it is building the bundle" : said;
    } catch (error) {
      if (!(error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))) throw error;
      // No answer this time (the container stopped under it, a timeout): the next ask starts it again.
      last = errorMessage(error);
    }
    if (Date.now() >= until) {
      throw refused(`${script}: no sites bundle from its container in ${Math.round(startTimeoutMs / 1000)} s: ${last}`);
    }
    await delay(pollMs);
  }
}

/** Puts `assets` in through an upload session for `script`'s next upload: the completion jwt that upload redeems. */
export async function uploadAssets(cf: CloudflareApi, script: string, assets: SitesBundle["assets"]): Promise<string> {
  const byHash = new Map<string, AssetFile>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const { path, content } of assets) {
    const hash = assetHash(content, path);
    manifest[path] = { hash, size: Buffer.byteLength(content, "base64") };
    byHash.set(hash, { hash, base64: content, contentType: mime.getType(path) ?? "application/octet-stream" });
  }
  const { jwt, buckets } = await cf.assetsSession(script, manifest);
  // Every asset already in: the session's jwt is the completion one.
  if (!buckets.length) return jwt;
  // Independent requests under one jwt: the one that completes the set answers the completion jwt.
  const answers = await Promise.all(
    buckets.map((bucket) =>
      cf.uploadAssets(
        jwt,
        bucket.map((hash) => {
          const file = byHash.get(hash);
          if (!file) throw refused(`${script}: the assets upload session asks for ${hash}, which no asset hashes to`);
          return file;
        }),
      ),
    ),
  );
  const completion = answers.find((answer) => answer !== undefined);
  if (!completion)
    throw refused(`${script}: the last bucket of assets was uploaded, and Cloudflare gave no completion jwt`);
  return completion;
}

/** What `serveSites` uploads again: the Worker as the deploy uploaded it. */
interface Deployed extends Polling {
  script: string;
  url: string;
  /** The instance token (`SANOMA_WAKEUP_TOKEN`), which the container's bundle route takes. */
  token: string;
  metadata: Omit<Upload, "migrations">;
}

/**
 * The public sites on the Worker: the bundle the container built, its assets uploaded, and the
 * Worker uploaded again with them and the sites router as its entry (its bindings, image and
 * revision as they were, so its container keeps running). When the container has none to give,
 * the Worker stays as the deploy uploaded it.
 */
export async function serveSites(
  cf: CloudflareApi,
  { script, url, token, metadata, ...polling }: Deployed,
): Promise<void> {
  const bundle = await sitesBundle(cf, script, url, token, polling);
  if (!bundle) return;
  if (bundle.mainModule !== "index.js") {
    throw refused(`${script}: the sites bundle's entry is ${bundle.mainModule}; the router imports sites/index.js`);
  }
  const jwt = await uploadAssets(cf, script, bundle.assets);
  await cf.upload(script, {
    ...metadata,
    main_module: SITES_MODULE,
    bindings: [...metadata.bindings, { type: "assets", name: ASSETS }],
    assets: { jwt, config: ASSETS_CONFIG },
    modules: [
      ...metadata.modules,
      await sitesRouter(),
      ...bundle.modules.map(({ name, type, content }) => ({
        name: `sites/${name}`,
        type,
        content: Buffer.from(content, "base64"),
      })),
    ],
  });
}
