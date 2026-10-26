// Before `start`: downloads Electron's binary when it is missing. The workspace skips Electron's
// install script (`allowBuilds` in pnpm-workspace.yaml), so a plain `pnpm install` stays small.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const dir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
if (!existsSync(join(dir, "path.txt"))) {
  console.error("downloading Electron's binary (once)");
  const { status } = spawnSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit" });
  process.exitCode = status ?? 1;
}
