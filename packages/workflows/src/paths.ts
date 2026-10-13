import { basename, dirname, isAbsolute, relative, sep } from "node:path";

// Where an import may reach, as the lints and the data-file reader all decide it, and the one
// walk up the directories. Node's `path` only, no parser: the oxlint plugin loads it.

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
