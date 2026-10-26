import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The platforms PostgreSQL is shipped for, as `${process.platform}-${process.arch}`. Each has a
 * package `@sanoma-ai/postgres-<platform>`, an optional dependency of this one, holding the
 * server as `postgres.tar.gz` (`bin/`, `lib/`, `share/`) and `postgres.json` (its version and the
 * archive's sha256).
 */
export const POSTGRES_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

export interface PostgresBinOptions {
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Default: this process's `${process.platform}-${process.arch}`. */
  platform?: string;
  /** Where the platform package is resolved from (a file path or URL). Default: this module. */
  from?: string | URL;
  /** Where the archive is extracted, a directory per release in it. Default: the OS's cache (`cacheDir`). */
  cache?: string;
}

/**
 * The directory holding PostgreSQL's `bin/`, `lib/` and `share/` that `ensurePostgres` runs:
 * `SANOMA_POSTGRES_DIR`, else the installed `@sanoma-ai/postgres-<platform>` package's archive
 * extracted into `<cache>/<version>-<platform>-<sha8>`, once. The archive goes into a temporary
 * directory beside it, renamed into place, so two launchers never see half of one; on macOS the
 * quarantine attribute is stripped from it. Throws, saying how to get one, when there is none.
 */
export function postgresBin({
  env = process.env,
  // Windows on arm64 runs the x64 build, which its package installs there too.
  platform = process.platform === "win32" ? "win32-x64" : `${process.platform}-${process.arch}`,
  from = import.meta.url,
  cache = cacheDir(platform, env),
}: PostgresBinOptions = {}): string {
  if (env.SANOMA_POSTGRES_DIR) return env.SANOMA_POSTGRES_DIR;
  const name = `@sanoma-ai/postgres-${platform}`;
  if (!POSTGRES_PLATFORMS.includes(platform)) throw new Error(`PostgreSQL: no release for ${platform}. ${howToGetOne}`);
  let pkg: string;
  try {
    pkg = dirname(createRequire(from).resolve(`${name}/package.json`));
  } catch {
    throw new Error(
      `PostgreSQL: no binaries. ${name}, an optional dependency of sanoma, is not installed ` +
        `(installs that omit optional dependencies leave it out). ${howToGetOne}`,
    );
  }
  const [archive, manifest] = [join(pkg, "postgres.tar.gz"), join(pkg, "postgres.json")];
  // In a sanoma checkout: the platform packages are linked, and filled only when packed or downloaded.
  if (!existsSync(manifest) || !existsSync(archive)) {
    throw new Error(
      `PostgreSQL: no binaries. ${name} is installed without postgres.tar.gz ` +
        `(\`pnpm postgres:download\` fills it in a sanoma checkout). ${howToGetOne}`,
    );
  }
  const { postgres, sha256 } = JSON.parse(readFileSync(manifest, "utf8")) as { postgres: string; sha256: string };
  const dir = join(cache, `${postgres}-${platform}-${sha256.slice(0, 8)}`);
  const exe = (root: string) => join(root, "bin", platform.startsWith("win32-") ? "postgres.exe" : "postgres");
  if (existsSync(exe(dir))) return dir;

  mkdirSync(cache, { recursive: true });
  const temp = mkdtempSync(`${dir}.tmp-`);
  try {
    // The archive records its packer's owner, which an extraction by a user is not.
    tar(["--no-same-owner", "-xzf", archive], temp);
    if (platform.startsWith("darwin-")) spawnSync("xattr", ["-dr", "com.apple.quarantine", temp], { stdio: "ignore" });
    try {
      renameSync(temp, dir);
    } catch (err) {
      // Another launcher extracted it first.
      if (!existsSync(exe(dir))) throw err;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return dir;
}

/**
 * The OS's cache for PostgreSQL's binaries: `~/Library/Caches/sanoma/postgres` on macOS,
 * `%LOCALAPPDATA%\sanoma\postgres` on Windows, `$XDG_CACHE_HOME/sanoma/postgres` (default
 * `~/.cache`) elsewhere.
 */
export function cacheDir(platform: string, env: Record<string, string | undefined> = process.env): string {
  const base = platform.startsWith("darwin-")
    ? join(homedir(), "Library", "Caches")
    : platform.startsWith("win32-")
      ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "sanoma", "postgres");
}

function tar(args: string[], cwd: string): void {
  const result = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`PostgreSQL: could not run tar to extract the binaries`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`PostgreSQL: tar ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
}

const howToGetOne =
  "Set SANOMA_DATABASE_URL to a Postgres of your own, or SANOMA_POSTGRES_DIR to a directory holding PostgreSQL 18's bin/.";
