import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// The root config runs packages/*/test only: this runs the tests here, with the root's aliases.
export default mergeConfig(root, defineConfig({ test: { include: ["test/**/*.test.ts"] } }));
