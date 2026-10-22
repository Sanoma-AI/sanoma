/**
 * Before a release (README "Release"): each public package left at a version already on npm must
 * take every new version it depends on, as npm has its ranges. An exact pin (`workspace:*`, as
 * `sanoma` pins the runtime) never does, nor a `^` peer range after a 0.x minor bump. Names each
 * package that needs a new version, counting the ones that will pin those in turn, and fails if
 * there is any. `release.yml` runs it before staging; `node scripts/release-check.ts` by hand.
 */
import { execFileSync } from "node:child_process";
import semver from "semver";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" });

/** The manifest npm has for this version, or undefined when npm has none (a new version or package). */
function published({ name, version }: Manifest): Manifest | undefined {
  try {
    const out = run("npm", ["view", `${name}@${version}`, "--json"]).trim();
    return out ? (JSON.parse(out) as Manifest) : undefined;
  } catch (err) {
    if (String((err as { stderr?: unknown }).stderr).includes("E404")) return undefined;
    throw err;
  }
}

const packages = (JSON.parse(run("pnpm", ["-r", "ls", "--depth", "-1", "--json"])) as Manifest[]).filter(
  (pkg) => !pkg.private,
);
const onNpm = new Map(packages.map((pkg) => [pkg.name, published(pkg)]));
/** The version each package will be released at: its own when new; a patch above when it needs one. */
const next = new Map(packages.filter((pkg) => !onNpm.get(pkg.name)).map((pkg) => [pkg.name, pkg.version]));
const needs: string[] = [];
for (let more = true; more;) {
  more = false;
  for (const pkg of packages) {
    const npm = onNpm.get(pkg.name);
    if (!npm || next.has(pkg.name)) continue;
    const ranges = { ...npm.dependencies, ...npm.peerDependencies, ...npm.optionalDependencies };
    const missed = Object.entries(ranges).find(
      ([dep, range]) => next.has(dep) && !semver.satisfies(next.get(dep)!, range),
    );
    if (!missed) continue;
    const [dep, range] = missed;
    needs.push(`${pkg.name}@${pkg.version} takes ${dep} ${range}, not ${next.get(dep)}: give it a new version too`);
    next.set(pkg.name, semver.inc(pkg.version, "patch")!);
    more = true;
  }
}
for (const line of needs) console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : line);
process.exitCode = needs.length ? 1 : 0;
