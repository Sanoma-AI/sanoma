import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AppBundle } from "sanoma/app";
import { DriverError, errorMessage } from "sanoma/workflows";
import { APP_BUNDLE_HEADER, APP_BUNDLE_PATH } from "sanoma/workflows/shared";
import mime from "mime";
import { refused } from "./errors.ts";
import { DEPLOYMENT_HEADER } from "../worker/instance.js";
import type { AssetFile, CloudflareApi, ContainerOptions } from "./ops.ts";

// What a deploy uploads as the company's Worker script: the package's `worker/` (the entry and the
// object's code) and the app bundle under `app/`, which the worker at the new revision's checkout
// builds and the object passes on (`appBundle`), its assets through an upload session.

const WORKER = new URL("../worker/", import.meta.url);

/** The Worker's entry module, which imports `cloudflare:workers`, `instance.js` and `app/index.js`. */
export const MAIN_MODULE = "index.js";
/** The Durable Object class the Worker exports, which the container application runs behind. */
export const OBJECT_CLASS = "SanomaInstance";
/** Where the app bundle's modules go in the upload: the entry imports `app/index.js`. */
export const APP = "app/";

/** One module of the Worker: its name in the upload, its source, and its kind (an ES module unless it says). */
export interface WorkerModule {
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
  type?: AppBundle["modules"][number]["type"];
}

let modules: Promise<{ entry: WorkerModule[]; noApp: WorkerModule }> | undefined;
const read = (file: string, name = file) =>
  readFile(new URL(file, WORKER), "utf8").then((content): WorkerModule => ({ name, content }));

/**
 * The package's own modules, read once: the entry and the object's code, and the placeholder app
 * (`worker/no-app.js` as `app/index.js`) of a create's uploads before its first bundle.
 */
export function workerModules() {
  modules ??= Promise.all([read(MAIN_MODULE), read("instance.js"), read("no-app.js", `${APP}index.js`)])
    .then(([entry, instance, noApp]) => ({ entry: [entry, instance], noApp }))
    .catch((err: unknown) => {
      modules = undefined;
      throw err;
    });
  return modules;
}

/** The bundle's modules as the upload names them, under `app/`; a refusal unless its main module is the one the entry imports. */
export function appModules(script: string, bundle: AppBundle): WorkerModule[] {
  if (bundle.mainModule !== "index.js") {
    throw refused(`${script}: the app bundle's main module is ${bundle.mainModule}; the Worker imports ${APP}index.js`);
  }
  return bundle.modules.map(({ name, type, content }) => ({
    name: `${APP}${name}`,
    type,
    content: Buffer.from(content, "base64"),
  }));
}

/**
 * How the Worker serves its assets: the client build under `/assets/` straight from them, every
 * other path through the Worker first (the app answers a prerendered page from them itself);
 * never an HTML rewrite or a fallback page of the assets' own.
 */
export const ASSETS_CONFIG = {
  html_handling: "none",
  not_found_handling: "none",
  run_worker_first: ["/*", "!/assets/*"],
} as const;

type Polling = Pick<ContainerOptions, "startTimeoutMs" | "pollMs">;

/**
 * A deploy's wait, with its own budget: `ask` every `pollMs` until it gives a value; a refusal it
 * throws ends the wait. Still none after `startTimeoutMs` is a retryable `DriverError`,
 * "`doing` after N s", with what the last ask saw.
 */
export async function waitFor<T>(
  doing: string,
  { startTimeoutMs, pollMs }: Polling,
  ask: () => Promise<{ value: T } | { last: string }>,
): Promise<T> {
  const until = Date.now() + startTimeoutMs;
  for (;;) {
    const seen = await ask();
    if ("value" in seen) return seen.value;
    if (Date.now() >= until) {
      throw new DriverError(`cloudflare: ${doing} after ${Math.round(startTimeoutMs / 1000)} s: ${seen.last}`, {
        retryable: true,
      });
    }
    await delay(pollMs);
  }
}

/**
 * Refuses (`superseded`) when the version `by` answered and Cloudflare lists it deployed after this
 * deploy's own upload (`mine`): another deploy uploaded since and has the host, and waiting would
 * only run out the time. Nothing for no version, this deploy's own, or an earlier one still
 * answering while the upload reaches every location; nor when either id is not listed (a listing
 * that lags) or the listing fails, so a deploy never fails on the listing alone.
 */
export async function refuseIfSuperseded(
  cf: CloudflareApi,
  script: string,
  mine: string,
  by: string | null | undefined,
): Promise<void> {
  if (!by || by === mine) return;
  const ids = await cf.deployments(script).catch((): string[] => []);
  const [newer, own] = [ids.indexOf(by), ids.indexOf(mine)];
  if (newer >= 0 && own >= 0 && newer < own) {
    throw refused(
      `${script}: superseded by version ${by}, uploaded after this deploy's (${mine}): a newer deploy has the host`,
      "superseded",
    );
  }
}

interface BundleAsk {
  script: string;
  url: string;
  token: string;
  revision: string;
  /** The id of the Worker version this deploy uploaded at the revision, whose answers alone count. */
  deployment: string;
}

/**
 * The app bundle at `revision`, asked of the Worker at `url` with the instance token until it
 * gives it: the object starts its container at the revision when it is stopped or runs another,
 * and both it and the worker answer 202 meanwhile. An answer without the version `deployment` is an
 * earlier version's, still answering while the upload reaches every location: asked again,
 * whatever its status; unless Cloudflare lists it deployed after `deployment`, which ends the wait
 * at once (`refuseIfSuperseded`). A failed build, a revision the route refuses, a container that ended or the
 * version uploaded refusing the ask (any 4xx of its own, such as another token's 401) is a refusal. Any other answer (no answer, an error of Cloudflare's, a body cut off, a workers.dev URL
 * not routed yet) is asked again. Still none after `startTimeoutMs` is a retryable `DriverError`
 * that says what the last ask saw. One ask may take the whole budget: a bundle is large.
 */
export function appBundle(
  cf: CloudflareApi,
  { script, url, token, revision, deployment }: BundleAsk,
  polling: Polling,
): Promise<AppBundle> {
  return waitFor<AppBundle>(`${script}: still building the app bundle at ${revision}`, polling, async () => {
    try {
      const res = await cf.send(`${url}${APP_BUNDLE_PATH}?revision=${encodeURIComponent(revision)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(polling.startTimeoutMs),
      });
      const by = res.headers.get(DEPLOYMENT_HEADER);
      if (by !== deployment) {
        await res.body?.cancel();
        await refuseIfSuperseded(cf, script, deployment, by);
        return { last: `an earlier version (${by || "unmarked"}) answered ${res.status}` };
      }
      const route = res.headers.has(APP_BUNDLE_HEADER);
      // Undefined when it is none (a body cut off where the JSON is).
      const body = (await res.json().catch(() => undefined)) as { error?: unknown; exit?: unknown } | undefined;
      if (route && res.status === 200 && body !== undefined) return { value: body as unknown as AppBundle };
      const said = typeof body?.error === "string" ? body.error : `${APP_BUNDLE_PATH} answered ${res.status}`;
      // The worker's own refusal (the build's failure, a revision it refuses), the container ended, or
      // the version uploaded refuses the ask (the token its bindings hold is another): none passes on asking.
      const own4xx = res.status >= 400 && res.status < 500;
      if (typeof body?.exit === "string" || own4xx || (route && res.status !== 200 && res.status !== 202))
        throw refused(`${script}: no app bundle at ${revision}: ${said}`);
      return {
        last: res.status === 202 ? (route ? "the worker is building it" : "its container is starting") : said,
      };
    } catch (error) {
      if (error instanceof DriverError) throw error;
      // No answer this time (a timeout, a body cut off): asked again.
      return { last: errorMessage(error) };
    }
  });
}

/** Puts the bundle's assets in through an upload session for `script`'s next upload: the completion jwt that upload redeems. */
export async function uploadAssets(cf: CloudflareApi, script: string, assets: AppBundle["assets"]): Promise<string> {
  const byHash = new Map<string, AssetFile>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const { path, content, hash, size } of assets) {
    manifest[path] = { hash, size };
    byHash.set(hash, { hash, base64: content, contentType: mime.getType(path) ?? "application/octet-stream" });
  }
  const { jwt, buckets } = await cf.assetsSession(script, manifest);
  // Every asset already in: the session's jwt is the completion one.
  if (!buckets.length) return jwt;
  // Every bucket's files first, so a hash no asset has is refused before any request starts.
  const files = buckets.map((bucket) =>
    bucket.map((hash) => {
      const file = byHash.get(hash);
      if (!file) throw refused(`${script}: the assets upload session asks for ${hash}, which no asset hashes to`);
      return file;
    }),
  );
  // One bucket after another, as Cloudflare limits how many it takes at once: the one that
  // completes the set answers the completion jwt.
  let completion: string | undefined;
  for (const bucket of files) completion = (await cf.uploadAssets(jwt, bucket)) ?? completion;
  if (!completion)
    throw refused(`${script}: every bucket of assets was uploaded, and Cloudflare gave no completion jwt`);
  return completion;
}
