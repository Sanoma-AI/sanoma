import { fileURLToPath } from "node:url";
import { ensureBuilt as ensure } from "@sanoma/testing";

/** The package's directory. */
export const pkg = fileURLToPath(new URL("..", import.meta.url));

/**
 * Builds the package's dist/ when what the tests load from it (the main entry, the describe
 * entry, and the oxlint plugin its `oxlint.json` loads) is missing or older than its source.
 */
export const ensureBuilt = () =>
  ensure(pkg, ["dist/index.js", "dist/describe.js", "dist/plugin.js"], ["pnpm", "run", "build"]);
