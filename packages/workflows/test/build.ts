import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's directory. */
export const pkg = fileURLToPath(new URL("..", import.meta.url));

/**
 * Builds the package's dist/ when it is missing or older than src/, for tests of what the
 * package ships: the built JavaScript, and the oxlint plugin its `oxlint.json` loads from dist/.
 */
export function ensureBuilt(): void {
  const built = join(pkg, "dist", "index.js");
  const stale =
    !existsSync(built) ||
    readdirSync(join(pkg, "src")).some((file) => statSync(join(pkg, "src", file)).mtimeMs > statSync(built).mtimeMs);
  if (!stale) return;
  // The package's build is this one tsc run.
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkg, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}${build.stdout}`);
}
