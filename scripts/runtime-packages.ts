/**
 * The runtime image's template project (`packages/sanoma/runtime/Dockerfile`, its `PACKAGES`):
 * `name@version` of `sanoma` and every public package of the workspace beside it, space-separated
 * on stdout, but the platform binaries (a package published with `os`), which come with the package that
 * depends on them. `release.yml` passes it once the release published them; with `--public`,
 * each at the version npm has now, the ones npm lacks left out, for a build before a release (CI).
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import type { Manifest } from "./release-check.ts";

/**
 * The workspace's public packages, each with its `publishConfig` (which `pnpm ls` leaves out). Here, not in
 * release-check.ts, which needs `semver`: this runs with no install.
 */
export function workspacePackages(): Manifest[] {
  return (JSON.parse(execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { encoding: "utf8" })) as Manifest[])
    .filter((pkg) => !pkg.private)
    .map((pkg) => {
      const { publishConfig } = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8")) as Manifest;
      return { ...pkg, publishConfig };
    });
}

/** The version npm has of `name` now, or undefined when it has no such package. */
async function published(name: string): Promise<string | undefined> {
  try {
    return (
      (await promisify(execFile)("npm", ["view", name, "version"], { encoding: "utf8" })).stdout.trim() || undefined
    );
  } catch (err) {
    if (String((err as { stderr?: unknown }).stderr).includes("E404")) return undefined;
    throw err;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { public: { type: "boolean" } } });
  const manifests = workspacePackages()
    .filter((pkg) => !pkg.publishConfig?.os)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  // Asked of npm all at once: one request each.
  const versions = await Promise.all(manifests.map(({ name, version }) => (values.public ? published(name) : version)));
  console.log(manifests.flatMap(({ name }, i) => (versions[i] ? [`${name}@${versions[i]}`] : [])).join(" "));
}
