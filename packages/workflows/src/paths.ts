import { basename, dirname, isAbsolute, relative, sep } from "node:path";

// Where an import may reach, as the lints and the data-file reader all decide it. Node's `path`
// only, no parser: the oxlint plugin loads it.

/** A relative import specifier: `./x.ts`, `../y.ts`. */
export const RELATIVE = /^\.\.?\//;

/** The file's nearest ancestor directory with one of `names` (`workflows`, `resources`), else its own directory. */
export function nearestDir(filename: string, names: readonly string[]): string {
  for (let dir = dirname(filename); ; dir = dirname(dir)) {
    if (names.includes(basename(dir))) return dir;
    if (dirname(dir) === dir) return dirname(filename);
  }
}

/** True when `path` is `dir` or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}
