import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// The root config's `include` covers packages/*/test only: this runs test/ from here (`pnpm test`).
export default mergeConfig(root, defineConfig({ test: { include: ["test/**/*.test.ts"] } }));
