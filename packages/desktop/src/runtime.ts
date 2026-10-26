import { join } from "node:path";
import { binOf } from "./launcher.ts";

/** The Node and the pnpm script the shell runs a company with. */
export interface Runtime {
  node: string;
  pnpm: string;
}

/**
 * Where they are: in a built app, the `node` and `pnpm` folders electron-builder copies into its
 * resources (`extraResources`); run from the checkout, `stage/node-<arch>` and `stage/pnpm`
 * beside the package (`scripts/stage.ts`). The pnpm script is the one its `package.json` names.
 */
export function runtimeOf(where: { packaged: boolean; appPath: string; resourcesPath: string }): Runtime {
  const [nodeDir, pnpmDir] = where.packaged
    ? [join(where.resourcesPath, "node"), join(where.resourcesPath, "pnpm")]
    : [join(where.appPath, "stage", `node-${process.arch}`), join(where.appPath, "stage", "pnpm")];
  return { node: join(nodeDir, "node"), pnpm: binOf(pnpmDir, "pnpm") };
}
