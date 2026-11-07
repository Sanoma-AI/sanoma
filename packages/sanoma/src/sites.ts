import { existsSync } from "node:fs";

/**
 * `sanoma/app/build` when the repo has a `sites/` directory, or an app has one
 * (`apps/<app>/sites/`): a repo without one never loads the app's build.
 */
export async function siteBuild(root: string) {
  const { kindDirs } = await import("sanoma/workflows");
  return kindDirs(root, "sites").some((dir) => existsSync(dir)) ? await import("sanoma/app/build") : undefined;
}
