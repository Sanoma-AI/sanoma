// Updating itself, on macOS: `update-electron-app` asks update.electronjs.org, Electron's service for
// public GitHub repositories, which offers the newest release tagged `v<x.y.z>` (neither a draft nor
// a prerelease) with a `-darwin-<arch>` zip; Squirrel.Mac downloads it and installs it when the app
// quits. A build that does not update itself checks for a newer release instead (update-check.ts).

/** The repository whose releases the app updates from. */
export const REPOSITORY = "Sanoma-AI/sanoma";

/**
 * Whether this build updates itself: built (not `start`), on macOS, signed with the Developer ID
 * (Squirrel.Mac takes only an update signed as the running app is, and an ad hoc signature is
 * each build's own), and run from an Applications folder (`inApplications`, asked on macOS only):
 * from the dmg, or moved nowhere and opened under App Translocation, the app is on a read-only
 * volume, where Squirrel.Mac fails every check. Windows has no release to update from yet; Linux
 * has no updater.
 */
export function updatesItself(build: {
  packaged: boolean;
  platform: NodeJS.Platform;
  signed: boolean;
  inApplications: () => boolean;
}): boolean {
  return build.packaged && build.platform === "darwin" && build.signed && build.inApplications();
}
