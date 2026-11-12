// Installs each agent of `agents.json` (argv[2]) under `<root>/<id>` (argv[3]) as the app installs
// one in a box's home (`install` in app/src/steps/agent/acp.ts): its packages added by pnpm with no
// install script, the vendor's own `setup` run, and `installed.json` the packages, which the app
// compares with the ones it wants.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [list, root] = process.argv.slice(2);
for (const { id, packages, setup } of JSON.parse(readFileSync(list, "utf8"))) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
  const pnpm = ["add", "--ignore-scripts", "--ignore-workspace", "--loglevel=error", ...packages];
  execFileSync("pnpm", pnpm, { cwd: dir, stdio: "inherit" });
  if (setup) {
    const at = join(dir, setup);
    execFileSync("node", [basename(at)], { cwd: dirname(at), stdio: "inherit" });
  }
  writeFileSync(join(dir, "installed.json"), JSON.stringify(packages));
}
