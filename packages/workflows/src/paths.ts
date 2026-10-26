import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_NAME } from "./shared.ts";

// Where an import may reach, as the lints and the data-file reader all decide it, the one walk up
// the directories and the one walk down (`filesUnder`). Node's `path` and `fs` only, no parser:
// the oxlint plugin loads it.

/** A relative import specifier: `./x.ts`, `../y.ts`. */
export const RELATIVE = /^\.\.?\//;

/**
 * What `found` returns for the nearest of `dir` and its ancestors for which it returns something,
 * nearest first; undefined when it returns nothing for any. The one walk up the directories.
 */
export function upFrom<T>(dir: string, found: (dir: string) => T | undefined): T | undefined {
  for (;;) {
    const value = found(dir);
    if (value !== undefined) return value;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The file's nearest ancestor directory with one of `names` (`workflows`, `resources`), else its own directory. */
export function nearestDir(filename: string, names: readonly string[]): string {
  return upFrom(dirname(filename), (dir) => (names.includes(basename(dir)) ? dir : undefined)) ?? dirname(filename);
}

/** True when `path` is `dir` or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** True when `path` is a directory. */
export const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** The files under `dir` whose name `keep` takes, sorted, outside `node_modules`; none when `dir` is not a directory. */
export function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && keep(d.name))
    .map((d) => join(d.parentPath, d.name))
    .filter((path) => !relative(dir, path).split(sep).includes("node_modules"))
    .toSorted();
}

/** Where a company's apps are, under its root: `apps/<app>/`. */
export const APPS_DIR = "apps";

/** Each directory's company root (the nearest one with a `sanoma.config.ts`, short of a `node_modules`), cached. */
const roots = new Map<string, string | null>();

/** Whether `dir` is a company's root: it holds a `sanoma.config.ts`. */
const isCompany = (dir: string) => existsSync(join(dir, "sanoma.config.ts"));

/**
 * The app a file is in: `<app>` for a file under `<root>/apps/<app>/`, where the root is the
 * nearest directory above it with a `sanoma.config.ts` (an app keeps its own `package.json`,
 * and its own config when merged from a company's repo: then the company is the one whose
 * `apps/` holds it; a `node_modules` ends the search: the file is a package's, not a company's);
 * undefined for a file at the root or outside any company. `defineWorkflow` and `collection()` name what they declare by it.
 */
export function appOfFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const dir = dirname(resolve(file));
  let root = roots.get(dir);
  if (root === undefined) {
    root =
      upFrom<string | null>(dir, (d) => (basename(d) === "node_modules" ? null : isCompany(d) ? d : undefined)) ?? null;
    // An app merged from a company's repo keeps that repo's config: the company is the one above.
    if (root !== null && basename(dirname(root)) === APPS_DIR && isCompany(dirname(dirname(root)))) {
      root = dirname(dirname(root));
    }
    roots.set(dir, root);
  }
  if (root === null) return undefined;
  const [top, app, ...rest] = relative(root, file).split(sep);
  return top === APPS_DIR && app !== undefined && rest.length && APP_NAME.test(app) ? app : undefined;
}

/** The apps' folders under `root` whose names are an `APP_NAME`, sorted: `apps/<app>/`, absolute. */
export function appFolders(root: string): string[] {
  const dir = join(root, APPS_DIR);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && APP_NAME.test(d.name))
    .map((d) => join(dir, d.name))
    .toSorted();
}

/** Where a kind of file is under `root`: `<root>/<kind>`, then each app's `apps/<app>/<kind>`, whether or not they exist. */
export const kindDirs = (root: string, kind: string): string[] => [
  join(root, kind),
  ...appFolders(root).map((app) => join(app, kind)),
];

/** Where a company's scenarios are, under its root and each app's folder. */
export const SCENARIOS_DIR = "scenarios";
