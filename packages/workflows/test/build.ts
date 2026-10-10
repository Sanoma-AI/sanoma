import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's directory. */
export const pkg = fileURLToPath(new URL("..", import.meta.url));

/** What the tests load from dist/: the main entry, the describe entry, and the oxlint plugin. */
const OUTPUTS = ["index.js", "describe.js", "plugin.js"];

/**
 * Builds the package's dist/ when an output the tests load is missing or older than a file under
 * src/, for tests of what the package ships: the built JavaScript, and the oxlint plugin its
 * `oxlint.json` loads from dist/. Two vitest processes in one checkout could both build at once;
 * `pnpm build` first avoids it.
 */
export function ensureBuilt(): void {
  const src = join(pkg, "src");
  const changed = Math.max(
    ...readdirSync(src, { recursive: true, encoding: "utf8" }).map((file) => statSync(join(src, file)).mtimeMs),
  );
  const outputs = OUTPUTS.map((file) => join(pkg, "dist", file));
  const stale = outputs.some((file) => !existsSync(file) || statSync(file).mtimeMs < changed);
  if (!stale) return;
  // The package's build is this one tsc run.
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkg, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}${build.stdout}`);
}
