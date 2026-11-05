import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * missing or older than a file under its `src/`: for tests of what a package ships, from its
 * `dist/`. Test files run at once, so each looks under a lock: one builds, and the rest wait and
 * find it built.
 */
export function ensureBuilt(pkgDir: string, outputs: readonly string[], build: readonly [string, ...string[]]): void {
  withLock(buildLock(pkgDir), () => {
    const src = join(pkgDir, "src");
    const changed = Math.max(
      ...readdirSync(src, { recursive: true, encoding: "utf8" }).map((file) => statSync(join(src, file)).mtimeMs),
    );
    const stale = outputs.some((output) => {
      const file = join(pkgDir, output);
      return !existsSync(file) || statSync(file).mtimeMs < changed;
    });
    if (stale) execFileSync(build[0], build.slice(1), { cwd: pkgDir, stdio: "inherit" });
  });
}

/**
 * Calls `get` every 100 ms until `done` holds for what it returns (by default, until that is
 * truthy), and returns it; throws after `timeoutMs`, naming the last value.
 */
export async function waitFor<T>(
  get: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last saw ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
