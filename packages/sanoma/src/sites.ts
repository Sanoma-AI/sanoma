import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * This package's `package.json`, by real path: a sites build's server bundle imports the runtime
 * as it resolves from here, the launcher's own copy, so the worker and the app share one.
 */
export const runtimeFrom = () => realpathSync(fileURLToPath(new URL("../package.json", import.meta.url)));

/**
 * `@sanoma-ai/app/build` when the repo has a `sites/` directory, or an app has one
 * (`apps/<app>/sites/`): a repo without one never loads the app's build.
 */
export async function siteBuild(root: string) {
  const { kindDirs } = await import("@sanoma-ai/workflows");
  return kindDirs(root, "sites").some((dir) => existsSync(dir)) ? await import("@sanoma-ai/app/build") : undefined;
}
