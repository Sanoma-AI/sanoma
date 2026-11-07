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
 * - A package at a version other than `sanoma`'s: every published package but the binaries
 *   (`@sanoma-ai/bridge-*`, `@sanoma-ai/postgres-*`, which follow the binary they download) is released
 *   with sanoma, at its version, so one of them changed is a new version for them all.
 *
 * Prints each `name@version` the release will publish, one per line. `release.yml` runs it before
 * publishing; `node scripts/release-check.ts` by hand.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import semver from "semver";
import { workspacePackages } from "./runtime-packages.ts";

export interface Manifest {
  name: string;
  version: string;
  /** The package's directory, absolute, as `pnpm ls --json` gives it. */
  path: string;
  private?: boolean;
  /** A binary package names the platforms it installs on. */
  publishConfig?: { os?: string[] };
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

/** A package.json as an install sees it: neither its devDependencies nor the scripts packing runs reach one. */
function shipped(text: string): string {
  const {
    devDependencies: _,
    scripts = {},
    ...manifest
  } = JSON.parse(text) as {
    devDependencies?: unknown;
    scripts?: Record<string, string>;
  };
  const { prepack: _pre, postpack: _post, ...rest } = scripts;
  return JSON.stringify({ ...manifest, scripts: rest });
}

/**
 * The files outside the package at `dir` that a package.json's `prepack` names (the download script of a
 * binary package), relative to `root`.
 */
const packedFrom = (text: string, dir: string, root: string): string[] =>
  String((JSON.parse(text) as { scripts?: { prepack?: string } }).scripts?.prepack ?? "")
    .split(/\s+/)
    .map((word) => join(dir, word))
    .filter((path) => !path.startsWith(dir + sep))
    .map((path) => relative(root, path));

/** Scripts' code, one after another: a comment's edit (a moved path in it) changes nothing they do. */
const codeOf = (files: { text: string }[]) => files.map(({ text }) => text.replace(/^\s*\/\/.*\n/gm, "")).join("\0");

/**
 * The commits since the one that last set this package's version, or removed its `private`, that touch
 * what it is built from: its directory (not `test/` or an `AGENTS.md`), its `package.json` when more than
 * its `devDependencies` and pack-time scripts differ, and the files outside it that its `prepack` names
 * when their code differs from then (wherever they were: a moved file is no change). Historical commits
 * alone do not require a bump when the effective inputs match the version-setting commit (for example,
 * after integrating a squash release).
 */
export function changedSince(pkg: Manifest, root = process.cwd()): string[] {
  const git = (...args: string[]) => run("git", args, root).trim();
  const manifest = join(pkg.path, "package.json");
  const set = git("log", "-1", "--format=%H", '-G"(version|private)":', "--", manifest);
  if (!set) return [];
  /** A file's text at the version-setting commit, or undefined when there was none. */
  const then = (path: string) => {
    try {
      return run("git", ["show", `${set}:./${path}`], root);
    } catch {
      return undefined;
    }
  };
  const now = readFileSync(manifest, "utf8");
  const before = then(relative(root, manifest))!;
  // Each file its prepack names, then and now, with its text.
  const was = packedFrom(before, pkg.path, root).flatMap((path) => {
    const text = then(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const is = packedFrom(now, pkg.path, root)
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const specs = [
    pkg.path,
    `:(exclude)${join(pkg.path, "test")}`,
    `:(exclude,glob)${pkg.path}/**/AGENTS.md`,
    ...(shipped(now) === shipped(before) ? [`:(exclude)${manifest}`] : []),
    ...(codeOf(was) === codeOf(is) ? [] : [...was, ...is].map(({ path }) => path)),
  ];
  if (!git("diff", "--name-only", set, "HEAD", "--", ...specs)) return [];
  return git("log", "--format=%h", `${set}..`, "--", ...specs)
    .split("\n")
    .filter(Boolean);
}

/** The platform binaries, which follow the binary they download, not sanoma's version. */
const BINARY = /^@sanoma-ai\/(bridge|postgres)-/;

/** The problems with releasing these packages, and each `name@version` the release will publish. */
export function releaseCheck(
  packages: Manifest[],
  npm: Map<string, OnNpm>,
  changed: (pkg: Manifest) => string[],
): { problems: string[]; publish: string[] } {
  const problems: string[] = [];
  const publish: string[] = [];
  /** The version each package will be released at: its own when new; a patch above when it needs one. */
  const next = new Map<string, string>();
  const bump = (pkg: Manifest) => next.set(pkg.name, semver.inc(pkg.version, "patch")!);
  const sanoma = packages.find((pkg) => pkg.name === "sanoma");
  /** Released together, at sanoma's version: one of them changed is a new version for them all. */
  const lockstep = packages.filter((pkg) => !BINARY.test(pkg.name));
  const bumpLockstep = () => lockstep.filter((pkg) => !next.has(pkg.name)).forEach(bump);
  const changes: string[] = [];
  for (const pkg of packages) {
    if (sanoma && lockstep.includes(pkg) && pkg.version !== sanoma.version) {
      problems.push(`${pkg.name}@${pkg.version} is not at sanoma's version, ${sanoma.version}: give it that one`);
    }
    const has = npm.get(pkg.name)!;
    if (has === "new package") {
      problems.push(
        `${pkg.name} is not on npm: publish it once by hand and set its trusted publisher (README "Release")`,
      );
    }
    if (typeof has === "string") {
      publish.push(`${pkg.name}@${pkg.version}`);
      next.set(pkg.name, pkg.version);
      continue;
    }
    const commits = changed(pkg);
    if (!commits.length) continue;
    const more = commits.length > 3 ? ` and ${commits.length - 3} more` : "";
    const change = `${pkg.name}@${pkg.version} is on npm, but ${commits.slice(0, 3).join(", ")}${more} changed its source since`;
    if (lockstep.includes(pkg)) changes.push(change);
    else {
      problems.push(`${change}: give it a new version`);
      bump(pkg);
    }
  }
  if (changes.length) {
    problems.push(
      ...changes.map((change) => `${change}: give it and every package released with sanoma a new version`),
    );
    bumpLockstep();
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
      if (lockstep.includes(pkg)) bumpLockstep();
      else bump(pkg);
      more = true;
    }
  }
  return { problems, publish };
}

if (import.meta.main) {
  const packages = workspacePackages();
  const npm = new Map(packages.map((pkg) => [pkg.name, onNpm(pkg)]));
  const { problems, publish } = releaseCheck(packages, npm, changedSince);
  for (const line of publish) console.log(line);
  for (const line of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::${line}` : line);
  process.exitCode = problems.length ? 1 : 0;
}
