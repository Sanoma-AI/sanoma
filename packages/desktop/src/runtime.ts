import { join } from "node:path";
import { binOf } from "./launcher.ts";

/** The Node and the pnpm script the shell runs a company with. */
export interface Runtime {
  node: string;
  pnpm: string;
}

/**
 * Where they are: in a built app, the `node` and `pnpm` folders Forge copies into its
 * resources (forge.config.mts); run from the checkout, `stage/node-<arch>` and `stage/pnpm`
 * beside the package (`scripts/stage.ts`). The Node is `node.exe` on Windows (`download-node.ts`);
 * the pnpm script is the one its `package.json` names.
 */
export function runtimeOf(
  where: { packaged: boolean; appPath: string; resourcesPath: string },
  platform: NodeJS.Platform = process.platform,
): Runtime {
  const [nodeDir, pnpmDir] = where.packaged
    ? [join(where.resourcesPath, "node"), join(where.resourcesPath, "pnpm")]
    : [join(where.appPath, "stage", `node-${process.arch}`), join(where.appPath, "stage", "pnpm")];
  return { node: join(nodeDir, platform === "win32" ? "node.exe" : "node"), pnpm: binOf(pnpmDir, "pnpm") };
}

/**
 * What to say when this is the x64 build translated on an Arm computer (Electron's
 * `runningUnderARM64Translation`): the arm64 build runs faster.
 */
export function archWarnings(translated: boolean, platform: NodeJS.Platform = process.platform): string[] {
  if (!translated) return [];
  return [
    platform === "win32"
      ? "This is the x64 build of Sanoma on an Arm PC: download the arm64 build, which runs faster."
      : "This is the Intel build of Sanoma on an Apple silicon Mac: download the Apple silicon (arm64) build, which runs faster.",
  ];
}
