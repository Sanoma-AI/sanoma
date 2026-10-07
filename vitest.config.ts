import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source, not dist/. Keep in sync with `paths` in tsconfig.json.
    alias: [
      { find: /^@sanoma\/(workflows|testing)$/, replacement: src("./packages/$1/src/index.ts") },
      { find: /^@sanoma\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
