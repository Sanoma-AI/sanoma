import { writeFileSync } from "node:fs";
import { readRootSnapshot, type SanomaConfig } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { domainsOf } from "@sanoma-ai/workflows/shared";
import { siteBuild } from "./sites.ts";

/**
 * `sanoma app-bundle --out <file>` (hidden), in a checkout the worker's port made for a revision
 * (`appBundleRoute`): the app bundle the Cloudflare host's Worker script runs (`buildWorker` in
 * `@sanoma-ai/app/build`), each public site's `domain` from `SANOMA_DOMAINS`, written to `out`
 * as JSON, or `null` when the checkout has nothing for the Worker.
 */
export async function writeAppBundle(
  config: SanomaConfig,
  { root, out, log }: { root: string; out: string; log: (line: string) => void },
): Promise<void> {
  const domains = process.env.SANOMA_DOMAINS ? domainsOf(process.env.SANOMA_DOMAINS) : {};
  const described = describeConfig(config);
  const description = {
    ...described,
    sites: described.sites.map((site) => (domains[site.name] ? { ...site, domain: domains[site.name] } : site)),
  };
  const build = await siteBuild(root);
  const bundle = await build?.buildWorker(root, {
    configFile: config.file!,
    description,
    snapshot: readRootSnapshot(config),
    log,
  });
  writeFileSync(out, JSON.stringify(bundle ?? null));
}
