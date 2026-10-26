// The update check: the shell is unsigned, so it cannot update itself (Squirrel.Mac and
// electron-updater refuse an unsigned app). It asks GitHub Releases for a newer `desktop-v*` and
// links to its page; the person downloads and replaces the app.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The repository's latest releases: desktop releases share it with nothing else, but keep to the tag prefix. */
export const RELEASES_URL = "https://api.github.com/repos/Sanoma-AI/sanoma/releases?per_page=20";
export const TAG_PREFIX = "desktop-v";
/** At most one check a day, counted from the last one that answered. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** The fields of a GitHub release the check reads. */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

/** A release newer than the running app: its version and its page. */
export interface Newer {
  version: string;
  url: string;
}

/** `x.y.z` as numbers, or undefined for anything else (a `-beta.1` suffix included). */
const parse = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
};

/** Whether `a` is a later `x.y.z` than `b`, comparing each part as a number (0.10.0 after 0.9.0). */
function later(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Whether version `a` is later than `b`; false when either is not `x.y.z`. */
function isLater(a: string, b: string): boolean {
  const [pa, pb] = [parse(a), parse(b)];
  return !!pa && !!pb && later(pa, pb);
}

/**
 * The newest published desktop release later than `current`, if any: tags `desktop-v<x.y.z>` that
 * are neither drafts nor prereleases.
 */
export function newerRelease(current: string, releases: readonly GitHubRelease[]): Newer | undefined {
  let best = parse(current);
  if (!best) return undefined;
  let found: Newer | undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith(TAG_PREFIX)) continue;
    // The page the shell opens in the browser: GitHub's, nothing else.
    if (!release.html_url.startsWith("https://github.com/")) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    const parts = parse(version);
    if (parts && later(parts, best)) {
      best = parts;
      found = { version, url: release.html_url };
    }
  }
  return found;
}

/** Asks GitHub, unauthenticated (60 requests an hour per address, plenty at one a day). */
export async function fetchReleases(current: string, fetchImpl: typeof fetch = fetch): Promise<GitHubRelease[]> {
  const res = await fetchImpl(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `Sanoma/${current}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  return (await res.json()) as GitHubRelease[];
}

/** The shell's own settings (`<userData>/settings.json`): only the update check's for now. */
export interface Settings {
  /** When GitHub last answered the check (ISO time). */
  updateCheckedAt?: string;
  /** What that check found, kept for the Help menu between checks and notified once per version. */
  newer?: Newer;
}

export function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  try {
    const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof settings === "object" && settings !== null && !Array.isArray(settings) ? (settings as Settings) : {};
  } catch {
    return {};
  }
}

/** Merges `next` into the file, through a temporary file and a rename. */
export function writeSettings(file: string, next: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...readSettings(file), ...next }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The release the last check found, while it is still later than the app (`current`). */
export function savedNewer(settings: Settings, current: string): Newer | undefined {
  const saved = settings.newer;
  return saved && typeof saved.version === "string" && isLater(saved.version, current) ? saved : undefined;
}

/** Whether a check's find gets a notification: once per version, so not the one the last check found. */
export function shouldNotify(settings: Settings, found: Newer | undefined): found is Newer {
  return !!found && found.version !== settings.newer?.version;
}

/** Whether a day has passed since the last check (or there was none, or the clock went back). */
export function checkDue(settings: Settings, now: number): boolean {
  const last = settings.updateCheckedAt ? Date.parse(settings.updateCheckedAt) : Number.NaN;
  return Number.isNaN(last) || now < last || now - last >= CHECK_EVERY_MS;
}
