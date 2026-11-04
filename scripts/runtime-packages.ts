/**
 * The runtime image's template project (`packages/sanoma/runtime/Dockerfile`, its `PACKAGES`):
 * `name@version` of `sanoma` and every public package of the workspace beside it, space-separated
 * on stdout, but the platform binaries (a package published with `os`), which come with the package that
 * depends on them. `release.yml` passes it once the release published them; with `--public`,
 * each at the version npm has now, the ones npm lacks left out, for a build before a release (CI).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { public: { type: "boolean" } } });

interface Manifest {
  name: string;
  version: string;
  /** The package's directory, absolute, as `pnpm ls --json` gives it. */
  path: string;
  private?: boolean;
}

/** The version npm has of `name` now, or undefined when it has no such package. */
function published(name: string): string | undefined {
  try {
    return execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: "pipe" }).trim() || undefined;
  } catch (err) {
    if (String((err as { stderr?: unknown }).stderr).includes("E404")) return undefined;
    throw err;
  }
}

const workspace = JSON.parse(
  execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" }),
) as Manifest[];
const manifests = workspace
  .filter((pkg) => !pkg.private && !JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8")).publishConfig?.os)
  .toSorted((a, b) => a.name.localeCompare(b.name));

const specs = manifests.flatMap(({ name, version }) => {
  const at = values.public ? published(name) : version;
  return at ? [`${name}@${at}`] : [];
});
console.log(specs.join(" "));
