import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** A folder holds a company when it has a `sanoma.config.ts`. */
export const isCompanyFolder = (dir: string) => existsSync(join(dir, "sanoma.config.ts"));

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folder named on a command line (`argv` without the executable), resolved against `cwd`:
 * the last argument that is a directory and not `appPath`, the app's own folder a checkout's
 * shell is started with (`electron <app path>`, wherever its flags put it). Flags, such as
 * Chromium's, and anything else are skipped.
 */
export function folderArgument(args: readonly string[], cwd: string, appPath?: string): string | undefined {
  return args
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => resolve(cwd, arg))
    .filter((path) => path !== appPath)
    .findLast(isDirectory);
}

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Why a company at `path` may break: a folder iCloud syncs (`~/Library/Mobile Documents`, or
 * Desktop and Documents when iCloud keeps them) moves files out from under `node_modules` and git.
 */
export function syncedFolderWarning(
  path: string,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const icloud = join(home, "Library", "Mobile Documents");
  const synced =
    inside(path, icloud) ||
    ["Desktop", "Documents"].some(
      (dir) => inside(path, join(home, dir)) && exists(join(icloud, "com~apple~CloudDocs", dir)),
    );
  return synced
    ? `${path} is in a folder iCloud syncs, which can break its packages and its git history: a folder outside iCloud, such as ~/Companies, is safer`
    : undefined;
}
