import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether the process `pid` is running; yes when it is another user's. */
function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs `fn` holding the lock `file`: made exclusively, this pid in it, removed after. Another
 * process's is waited for, unless that process is gone. Empty, its maker is about to write its
 * pid, or died first if that was seconds ago.
 */
function withLock(file: string, fn: () => void): void {
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: string;
    let fresh: boolean;
    try {
      holder = readFileSync(file, "utf8");
      fresh = !holder && Date.now() - statSync(file).mtimeMs < 5_000;
    } catch {
      continue; // Removed meanwhile.
    }
    if (!fresh && !alive(Number(holder))) rmSync(file, { force: true });
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try {
    fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** The file `ensureBuilt` locks for `pkgDir`: outside the checkout, where tests watch what a build writes. */
export const buildLock = (pkgDir: string): string =>
  join(tmpdir(), `sanoma-ensure-built-${createHash("sha256").update(pkgDir).digest("hex").slice(0, 16)}.lock`);

/**
 * Runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` (paths in it) is
 * missing or older than a file `sources` matches (globs in it; by default, everything under its
 * `src/`): for tests of what a package ships, from its `dist/`. A build leaves an output it finds up
 * to date as it was (`tsc -b`), so once it succeeds every output older than its start is marked built
 * then. Test files run at once, so each looks under a lock: one builds, and the rest wait and find it
 * built.
 */
export function ensureBuilt(
  pkgDir: string,
  outputs: readonly string[],
  build: readonly [string, ...string[]],
  sources: readonly string[] = ["src/**"],
): void {
  withLock(buildLock(pkgDir), () => {
    const mtime = (path: string) => statSync(join(pkgDir, path)).mtimeMs;
    const changed = Math.max(...globSync(sources, { cwd: pkgDir }).map(mtime));
    const stale = outputs.some((output) => !existsSync(join(pkgDir, output)) || mtime(output) < changed);
    if (!stale) return;
    const start = new Date();
    // Not the tests' NODE_ENV (vitest's `test`): a build under it writes React's development build.
    const { NODE_ENV: _, ...env } = process.env;
    execFileSync(build[0], build.slice(1), { cwd: pkgDir, env, stdio: "inherit" });
    for (const output of outputs) if (mtime(output) < start.getTime()) utimesSync(join(pkgDir, output), start, start);
  });
}

/**
 * Calls `get` every `everyMs` (100 ms) until `done` holds for what it returns (by default, until
 * that is truthy), and returns it; throws after `timeoutMs`, naming the last value.
 */
export async function waitFor<T>(
  get: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 15_000,
  everyMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last saw ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
