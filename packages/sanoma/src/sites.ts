import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's `package.json`, by real path: a sites build's server bundle imports the runtime
 * as it resolves from here, the launcher's own copy, so the worker and the app share one.
 */
export const runtimeFrom = () => realpathSync(fileURLToPath(new URL("../package.json", import.meta.url)));

/** `@sanoma-ai/app/build` when the repo has a `sites/` directory: a repo without one never loads the app's build. */
export const siteBuild = async (root: string) =>
  existsSync(join(root, "sites")) ? await import("@sanoma-ai/app/build") : undefined;
