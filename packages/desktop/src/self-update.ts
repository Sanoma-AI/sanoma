// Updating itself: `update-electron-app` asks update.electronjs.org (which releases it offers: the
// root README's "Desktop (preview)"); Squirrel (Electron's `autoUpdater`) downloads the update, and
// the next launch is the new version. A build that does not update itself checks for a newer
// release instead (update-check.ts).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The repository whose releases the app updates from. */
export const REPOSITORY = "Sanoma-AI/sanoma";

/**
 * Whether this build updates itself: built (not `start`), signed for release (Squirrel.Mac takes
 * only an update signed as the running app is, and an ad hoc signature is each build's own;
 * Squirrel.Windows checks nothing, so an unsigned build is simply not offered one), on macOS or
 * Windows (Linux has no updater), and installed (`installed`, asked last): on macOS in an
 * Applications folder, as from the dmg, or moved nowhere and opened under App Translocation, the app
 * is on a read-only volume, where Squirrel.Mac fails every check; on Windows by Squirrel's installer
 * (`installedBySquirrel`).
 */
export function updatesItself(build: {
  packaged: boolean;
  platform: NodeJS.Platform;
  signed: boolean;
  installed: () => boolean;
}): boolean {
  const updater = build.platform === "darwin" || build.platform === "win32";
  return build.packaged && updater && build.signed && build.installed();
}

/** Whether Squirrel installed the Windows app at `execPath`, in `app-<version>` beside its `Update.exe`. */
export const installedBySquirrel = (execPath: string, exists: (path: string) => boolean = existsSync) =>
  exists(join(dirname(execPath), "..", "Update.exe"));

/**
 * The id Squirrel.Windows gives the shortcuts it makes (`com.squirrel.<package id>.<exe>`,
 * `CreateShortcutsForExecutable`, for `MakerSquirrel`'s `name` and the app's exe): the app must run
 * under it for its notifications to show and its taskbar pin to stay itself.
 */
export const WINDOWS_APP_ID = "com.squirrel.Sanoma.Sanoma";

/**
 * How long the first update check waits, in ms: on the launch right after the install, Squirrel still
 * holds its update lock for about 10 seconds, and a check meanwhile fails.
 */
export const firstCheckDelay = (argv: readonly string[]) => (argv.includes("--squirrel-firstrun") ? 15_000 : 0);
