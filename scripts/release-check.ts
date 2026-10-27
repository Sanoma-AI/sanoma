/**
 * Before a release (README "Release"): names each public package that would make the release wrong, and
 * fails if there is any.
 *
 * - A package npm does not have yet. npm adds a trusted publisher only to a package that exists, and
 *   `pnpm publish -r` stops at the first package it cannot publish, so a new one is published by hand first.
 * - A package left at a version already on npm whose source changed since the commit that set that
 *   version (or made the package public): npm's copy lacks the change, so it needs a new version.
 * - A package left at a public version that must take every new version it depends on, as npm has its
 *   ranges. An exact pin (`workspace:*`, as `sanoma` pins the runtime) never does, nor a `^` peer range
 *   after a 0.x minor bump. Counts the ones that will pin those in turn.
 *
 * Prints each `name@version` the release will publish, one per line. `release.yml` runs it before
 * publishing; `node scripts/release-check.ts` by hand.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import semver from "semver";

export interface Manifest {
  name: string;
  version: string;
  /** The package's directory, absolute, as `pnpm ls --json` gives it. */
  path: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** What npm has for a package at its workspace version: that version's manifest, or neither it nor the package. */
export type OnNpm = Omit<Manifest, "path"> | "new version" | "new package";

const run = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

/** `npm view`'s output, or undefined when npm has no such package or version. */
function view(args: string[]): string | undefined {
  try {
    return run("npm", ["view", ...args]).trim() || undefined;
  } catch (err) {
    if (String((err as { stderr?: unknown }).stderr).includes("E404")) return undefined;
    throw err;
  }
}

function onNpm({ name, version }: Manifest): OnNpm {
  const manifest = view([`${name}@${version}`, "--json"]);
  if (manifest) return JSON.parse(manifest) as Manifest;
  return view([name, "name"]) ? "new version" : "new package";
}

/** A package.json as an install sees it: its devDependencies never reach one. */
const shipped = (text: string) => JSON.stringify({ ...JSON.parse(text), devDependencies: undefined });

/**
 * The commits since the one that last set this package's version, or removed its `private`, that touch
 * what it is built from: its directory (not `test/` or an `AGENTS.md`), a file outside it that its
 * `prepack` names (the download script of a binary package), and its `package.json` when more than its
 * `devDependencies` differs.
 */
export function changedSince(pkg: Manifest, root = process.cwd()): string[] {
  const git = (...args: string[]) => run("git", args, root).trim();
  const manifest = join(pkg.path, "package.json");
  const set = git("log", "-1", "--format=%H", '-G"(version|private)":', "--", manifest);
  if (!set) return [];
  const now = readFileSync(manifest, "utf8");
  const same = shipped(now) === shipped(git("show", `${set}:./${relative(root, manifest)}`));
  const prepack = String((JSON.parse(now) as { scripts?: { prepack?: string } }).scripts?.prepack ?? "")
    .split(/\s+/)
    .map((word) => join(pkg.path, word))
    .filter((path) => !path.startsWith(pkg.path + sep) && existsSync(path));
  const specs = [
    pkg.path,
    `:(exclude)${join(pkg.path, "test")}`,
    `:(exclude,glob)${pkg.path}/**/AGENTS.md`,
    ...(same ? [`:(exclude)${manifest}`] : []),
    ...prepack,
  ];
  return git("log", "--format=%h", `${set}..`, "--", ...specs)
    .split("\n")
    .filter(Boolean);
}

/** The problems with releasing these packages, and each `name@version` the release will publish. */
export function releaseCheck(
  packages: Manifest[],
  npm: Map<string, OnNpm>,
  changed: (pkg: Manifest) => string[],
): { problems: string[]; publish: string[] } {
  const problems: string[] = [];
  /** The version each package will be released at: its own when new; a patch above when it needs one. */
  const next = new Map<string, string>();
  for (const pkg of packages) {
    const has = npm.get(pkg.name)!;
    if (has === "new package") {
      problems.push(
        `${pkg.name} is not on npm: publish it once by hand and set its trusted publisher (README "Release")`,
      );
    }
    if (typeof has === "string") {
      next.set(pkg.name, pkg.version);
      continue;
    }
    const commits = changed(pkg);
    if (!commits.length) continue;
    const more = commits.length > 3 ? ` and ${commits.length - 3} more` : "";
    problems.push(
      `${pkg.name}@${pkg.version} is on npm, but ${commits.slice(0, 3).join(", ")}${more} changed its source since: give it a new version`,
    );
    next.set(pkg.name, semver.inc(pkg.version, "patch")!);
  }
  for (let more = true; more;) {
    more = false;
    for (const pkg of packages) {
      const has = npm.get(pkg.name)!;
      if (typeof has === "string" || next.has(pkg.name)) continue;
      const ranges = { ...has.dependencies, ...has.peerDependencies, ...has.optionalDependencies };
      const missed = Object.entries(ranges).find(
        ([dep, range]) => next.has(dep) && !semver.satisfies(next.get(dep)!, range),
      );
      if (!missed) continue;
      const [dep, range] = missed;
      problems.push(
        `${pkg.name}@${pkg.version} takes ${dep} ${range}, not ${next.get(dep)}: give it a new version too`,
      );
      next.set(pkg.name, semver.inc(pkg.version, "patch")!);
      more = true;
    }
  }
  const publish = packages.filter((pkg) => typeof npm.get(pkg.name) === "string");
  return { problems, publish: publish.map((pkg) => `${pkg.name}@${pkg.version}`) };
}

if (import.meta.main) {
  const packages = (JSON.parse(run("pnpm", ["-r", "ls", "--depth", "-1", "--json"])) as Manifest[]).filter(
    (pkg) => !pkg.private,
  );
  const npm = new Map(packages.map((pkg) => [pkg.name, onNpm(pkg)]));
  const { problems, publish } = releaseCheck(packages, npm, (pkg) => changedSince(pkg));
  for (const line of publish) console.log(line);
  for (const line of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : line);
  process.exitCode = problems.length ? 1 : 0;
}
