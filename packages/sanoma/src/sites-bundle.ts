import { createHash, timingSafeEqual } from "node:crypto";
import type { IngressRoute } from "@sanoma-ai/app";
import { errorMessage, readRootSnapshot, resolveConfig, type SanomaConfig } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { SITES_BUNDLE_PATH } from "@sanoma-ai/workflows/shared";
import { siteBuild } from "./sites.ts";

/** What the route builds from: the config, the checkout it was loaded from, and the host's domains. */
export interface SitesBundleOptions {
  root: string;
  /** The public sites' domains, by site name (`SANOMA_DOMAINS`). */
  domains: Record<string, string>;
  /** The instance token (`SANOMA_WAKEUP_TOKEN`) the route takes as a bearer. */
  token: string;
  log: (line: string) => void;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * `GET /__sanoma/sites-bundle` with the instance token: the bundle of the public sites the
 * Cloudflare host's Worker serves (`buildWorker` in `@sanoma-ai/app/build`), which a deploy
 * downloads once the container answers. Built on the first ask, in the background: 202 while it
 * builds, then 200 with the bundle as JSON; 404 when no site is the Worker's to serve (each is
 * private, without a domain, or has a login). A failed build answers 500 with why, once, and the
 * next ask builds again.
 */
export function sitesBundleRoute(
  config: SanomaConfig,
  { root, domains, token, log }: SitesBundleOptions,
): IngressRoute {
  const expected = digest(`Bearer ${token}`);
  let building: Promise<void> | undefined;
  let answer: { status: number; body: string } | undefined;
  const build = async () => {
    const sites = await siteBuild(root);
    const described = describeConfig(config);
    const description = {
      ...described,
      sites: described.sites.map((site) => (domains[site.name] ? { ...site, domain: domains[site.name] } : site)),
    };
    const bundle = await sites?.buildWorker(root, {
      configFile: config.file!,
      description,
      snapshot: readRootSnapshot(config, resolveConfig(config)),
      log,
    });
    if (bundle) log(`built the sites bundle for the Worker: ${bundle.sites.join(", ")}`);
    answer = bundle
      ? { status: 200, body: JSON.stringify(bundle) }
      : { status: 404, body: JSON.stringify({ error: "no public site without a login has a domain" }) };
  };
  return {
    method: "GET",
    path: SITES_BUNDLE_PATH,
    async handle(request) {
      if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), expected)) {
        return Response.json({ error: "the token is not this instance's SANOMA_WAKEUP_TOKEN" }, { status: 401 });
      }
      if (answer) {
        const { status, body } = answer;
        if (status === 500) answer = undefined;
        return new Response(body, {
          status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      building ??= build()
        .catch((err: unknown) => {
          log(`building the sites bundle for the Worker failed: ${errorMessage(err)}`);
          answer = { status: 500, body: JSON.stringify({ error: errorMessage(err) }) };
        })
        .finally(() => (building = undefined));
      return Response.json({ building: true }, { status: 202, headers: { "cache-control": "no-store" } });
    },
  };
}
