import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` (paths in it) is
 * missing or older than a file under its `src/`: for tests of what a package ships, from its
 * `dist/`. Two vitest processes in one checkout could both build at once; `pnpm build` first
 * avoids it.
 */
export function ensureBuilt(pkgDir: string, outputs: readonly string[], build: readonly [string, ...string[]]): void {
  const src = join(pkgDir, "src");
  const changed = Math.max(
    ...readdirSync(src, { recursive: true, encoding: "utf8" }).map((file) => statSync(join(src, file)).mtimeMs),
  );
  const stale = outputs.some((output) => {
    const file = join(pkgDir, output);
    return !existsSync(file) || statSync(file).mtimeMs < changed;
  });
  if (stale) execFileSync(build[0], build.slice(1), { cwd: pkgDir, stdio: "inherit" });
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
