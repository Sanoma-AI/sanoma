import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The path a company is known by: its real path, which on Windows is also in the case the disk has
 * (`realpathSync.native`), as `C:\Users\a\acme` and `c:\users\a\ACME` are one folder there.
 */
export const realPathOf = (dir: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? realpathSync.native(dir) : realpathSync(dir);

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
 * Which service syncs `path`, when one does: on a Mac, iCloud (`~/Library/Mobile Documents`, or
 * Desktop and Documents when iCloud keeps them); on Windows, OneDrive (its folders are in the
 * environment, and Desktop and Documents are in them when OneDrive keeps those) or iCloud
 * (`~/iCloudDrive`).
 */
function syncedBy(
  path: string,
  home: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "win32") {
    const onedrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial];
    if (onedrive.some((dir) => dir && inside(path, dir))) return "OneDrive";
    return inside(path, join(home, "iCloudDrive")) ? "iCloud" : undefined;
  }
  const icloud = join(home, "Library", "Mobile Documents");
  const synced =
    inside(path, icloud) ||
    ["Desktop", "Documents"].some(
      (dir) => inside(path, join(home, dir)) && exists(join(icloud, "com~apple~CloudDocs", dir)),
    );
  return synced ? "iCloud" : undefined;
}

/**
 * Why a company at `path` may break: a folder iCloud or OneDrive syncs (`syncedBy`) moves files
 * out from under `node_modules` and git.
 */
export function syncedFolderWarning(
  path: string,
  home: string,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const service = syncedBy(path, home, exists, platform, env);
  const safer = platform === "win32" ? join(home, "Companies") : "~/Companies";
  return service
    ? `${path} is in a folder ${service} syncs, which can break its packages and its git history: a folder outside ${service}, such as ${safer}, is safer`
    : undefined;
}
