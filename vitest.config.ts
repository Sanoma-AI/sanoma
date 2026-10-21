import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source, not dist/. Keep in sync with `paths` in tsconfig.json.
    alias: [
      {
        find: /^@sanoma-ai\/workflows\/(data|describe|fake|plugin|shared|scenario|scenarios)$/,
        replacement: src("./packages/workflows/src/$1.ts"),
      },
      { find: /^@sanoma-ai\/workflows\/resources$/, replacement: src("./packages/workflows/src/secret.ts") },
      {
        find: /^@sanoma-ai\/testing\/(features|harness|host|replay|scenarios)$/,
        replacement: src("./packages/testing/src/$1.ts"),
      },
      { find: /^@sanoma-ai\/bridge\/(connector|fake|tfschema)$/, replacement: src("./packages/bridge/src/$1.ts") },
      { find: /^@sanoma-ai\/app\/build$/, replacement: src("./packages/app/src/build.ts") },
      { find: /^@sanoma-ai\/(workflows|testing|app|bridge)$/, replacement: src("./packages/$1/src/index.ts") },
      {
        find: /^@sanoma-ai\/connector-([a-z0-9-]+)\/(driver|fake|resources)$/,
        replacement: src("./connectors/$1/src/$2.ts"),
      },
      { find: /^@sanoma-ai\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
      { find: /^sanoma$/, replacement: src("./packages/sanoma/src/index.ts") },
      { find: /^sanoma\/resources$/, replacement: src("./packages/sanoma/src/resources.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "connectors/*/test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Every spy is undone before the next test, so a test needs no try/finally to put one back.
    restoreMocks: true,
    // The key stored credentials are encrypted with: made up for each run.
    env: { SANOMA_SECRETS_KEY: randomBytes(32).toString("base64") },
  },
});
