import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A lock older than this is a build that was killed: no package's build takes so long. */
const LOCK_STALE_MS = 5 * 60_000;

/** Runs `fn` holding the lock `dir`, waiting for any other process that holds it. */
function withLock(dir: string, fn: () => void): void {
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const taken = statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      if (Date.now() - taken > LOCK_STALE_MS) rmdirSync(dir);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    fn();
  } finally {
    rmdirSync(dir);
  }
}

/**
 * Runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` (paths in it) is
 * missing or older than a file under its `src/`: for tests of what a package ships, from its
 * `dist/`. Test files run at once, so they take turns under a lock in the package's `node_modules`:
 * one builds, and the rest find it built.
 */
export function ensureBuilt(pkgDir: string, outputs: readonly string[], build: readonly [string, ...string[]]): void {
  const src = join(pkgDir, "src");
  const stale = () => {
    const changed = Math.max(
      ...readdirSync(src, { recursive: true, encoding: "utf8" }).map((file) => statSync(join(src, file)).mtimeMs),
    );
    return outputs.some((output) => {
      const file = join(pkgDir, output);
      return !existsSync(file) || statSync(file).mtimeMs < changed;
    });
  };
  if (!stale()) return;
  withLock(join(pkgDir, "node_modules", ".ensure-built.lock"), () => {
    if (stale()) execFileSync(build[0], build.slice(1), { cwd: pkgDir, stdio: "inherit" });
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
