// Fills stage/, what electron-builder copies into the app's resources (`extraResources`) and what
// the shell runs from the checkout: `stage/node-<arch>` (the pinned Node, `download-node.ts`) for
// each architecture asked for (this one by default), and `stage/pnpm`, a copy of the pnpm that runs
// this script (its package, by real path), so the shell installs a company with the pnpm the
// workspace pins and needs no pnpm on the computer. pnpm is JavaScript, with its native
// helpers prebuilt for every architecture, so one copy serves both builds.
//
//   pnpm --filter @sanoma-ai/desktop run stage:resources [--arch arm64 --arch x64]
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { downloadNode } from "./download-node.ts";

const stage = fileURLToPath(new URL("../stage/", import.meta.url));
const { values } = parseArgs({ options: { arch: { type: "string", multiple: true } } });

for (const arch of values.arch ?? [process.arch]) {
  await downloadNode(`${process.platform}-${arch}`, join(stage, `node-${arch}`));
}

/** The pnpm package `pnpm run` was started from: `npm_execpath` is its bin script. */
function pnpmPackage(): string {
  const bin = process.env.npm_execpath;
  if (!bin)
    throw new Error(
      "run this through pnpm (`pnpm --filter @sanoma-ai/desktop run stage:resources`): it copies that pnpm",
    );
  for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "pnpm") {
      return dir;
    }
  }
  throw new Error(
    `${bin} is not inside a pnpm package: staging copies pnpm's JavaScript package, so run it with a pnpm from corepack or npm (not a standalone binary)`,
  );
}

const versionOf = (dir: string) =>
  existsSync(join(dir, "package.json"))
    ? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version
    : undefined;

const from = pnpmPackage();
const to = join(stage, "pnpm");
if (versionOf(to) !== versionOf(from)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
  console.error(`staged pnpm ${versionOf(to)} from ${from}`);
}
