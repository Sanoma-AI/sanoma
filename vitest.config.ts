import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source, not dist/. Keep in sync with `paths` in tsconfig.json.
    alias: [
      {
        find: /^@sanoma\/workflows\/(describe|fake|lint|shared|scenario)$/,
        replacement: src("./packages/workflows/src/$1.ts"),
      },
      { find: /^@sanoma\/testing\/(replay|scenarios)$/, replacement: src("./packages/testing/src/$1.ts") },
      { find: /^@sanoma\/(workflows|testing|app)$/, replacement: src("./packages/$1/src/index.ts") },
      {
        find: /^@sanoma\/connector-([a-z0-9-]+)\/(driver|fake)$/,
        replacement: src("./connectors/$1/src/$2.ts"),
      },
      { find: /^@sanoma\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "connectors/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Every spy is undone before the next test, so a test needs no try/finally to put one back.
    restoreMocks: true,
  },
});
