import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { upFrom } from "./company-file.ts";
import { APP_NAME, APPS_DIR, appOfPath } from "./shared.ts";

// Where an import may reach, as the lints and the data-file reader all decide it, the one walk up
// the directories and the one walk down (`filesUnder`). Node's `path` and `fs` only (and a
// bundle's registered roots, plain data), no parser: the oxlint plugin loads it.

/**
 * Where a data file imports `secret` from, and `sanoma`, the runtime's own resource constructors
 * (its people: `sanoma.person`, `.agent`, `.group`): what the loader serves for them.
 */
export const SECRET_ENTRIES: ReadonlySet<string> = new Set(["sanoma/resources"]);
/** Where a site imports `api`, `RunForm` and `defineSite` from: `sanoma/site`, the app's site surface. The loader serves `defineSite`. */
export const SITE_ENTRIES: ReadonlySet<string> = new Set(["sanoma/site"]);
/** Where `resources/data.ts` imports `collection` from: what the loader serves for it. */
export const DATA_ENTRIES: ReadonlySet<string> = new Set(["sanoma/data"]);
/**
 * The one data file that holds collections, relative to `resources/`. Workflows and the runtime
 * import it, so it holds collections only.
 */
export const COLLECTIONS_FILE = "data.ts";

/** A relative import specifier: `./x.ts`, `../y.ts`. */
export const RELATIVE = /^\.\.?\//;

/** The file's nearest ancestor directory with one of `names` (`workflows`, `resources`), else its own directory. */
export function nearestDir(filename: string, names: readonly string[]): string {
  return upFrom(dirname(filename), (dir) => (names.includes(basename(dir)) ? dir : undefined)) ?? dirname(filename);
}

/** True when `path` is `dir` or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/** `path`, under `root`, relative to it with `/`: `resources/github.ts`. */
export const relPath = (root: string, path: string): string => relative(root, path).split(sep).join("/");

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

export { APPS_DIR, appOfPath };

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

/**
 * The files whose declarations join the config's, as `sanoma` loads it and the Worker's bundle
 * imports them: each workflow source under `workflows/` and each app's (a test or a declaration
 * file aside), then each `resources/data.ts` there is.
 */
export function declarationFiles(root: string): { workflows: string[]; data: string[] } {
  return {
    workflows: kindDirs(root, "workflows").flatMap((dir) => filesUnder(dir, isWorkflowSource)),
    data: kindDirs(root, "resources")
      .map((dir) => join(dir, COLLECTIONS_FILE))
      .filter((path) => existsSync(path)),
  };
}

/** A workflow file's name: `.ts`, but a test (`.test.ts`, `.spec.ts`) or a declaration. */
const isWorkflowSource = (name: string) => name.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(name);

/** Where a company's scenarios are, under its root and each app's folder. */
export const SCENARIOS_DIR = "scenarios";
