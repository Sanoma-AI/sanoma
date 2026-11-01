import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source, not dist/. Keep in sync with `paths` in tsconfig.json.
    alias: [
      { find: /^@sanoma-ai\/invoices\/pdf-contract$/, replacement: src("./packages/invoices/src/render-contract.ts") },
      { find: /^@sanoma-ai\/invoices\/pdf$/, replacement: src("./packages/invoices/src/pdf.tsx") },
      { find: /^@sanoma-ai\/invoices\/browser$/, replacement: src("./packages/invoices/src/browser.ts") },
      { find: /^@sanoma-ai\/invoices\/node$/, replacement: src("./packages/invoices/src/node.ts") },
      { find: /^@sanoma-ai\/invoices$/, replacement: src("./packages/invoices/src/index.ts") },
      { find: /^@sanoma-ai\/invoices\/examples$/, replacement: src("./packages/invoices/src/examples.ts") },
      {
        find: /^@sanoma-ai\/workflows\/(cloud-identity|kms-secrets|data|describe|description|fake|plugin|shared|scenario|scenarios|wakeup-service)$/,
        replacement: src("./packages/workflows/src/$1.ts"),
      },
      { find: /^@sanoma-ai\/workflows\/resources$/, replacement: src("./packages/workflows/src/constructors.ts") },
      {
        find: /^@sanoma-ai\/testing\/(database|features|harness|host|replay|scenarios|wakeup)$/,
        replacement: src("./packages/testing/src/$1.ts"),
      },
      { find: /^@sanoma-ai\/bridge\/(connector|fake|tfschema)$/, replacement: src("./packages/bridge/src/$1.ts") },
      { find: /^@sanoma-ai\/app\/build$/, replacement: src("./packages/app/src/build.ts") },
      { find: /^@sanoma-ai\/(workflows|testing|app|bridge)$/, replacement: src("./packages/$1/src/index.ts") },
      {
        find: /^@sanoma-ai\/connector-([a-z0-9-]+)\/(driver|fake|resources|remote|vault)$/,
        replacement: src("./connectors/$1/src/$2.ts"),
      },
      { find: /^@sanoma-ai\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
      { find: /^sanoma$/, replacement: src("./packages/sanoma/src/index.ts") },
      { find: /^sanoma\/resources$/, replacement: src("./packages/sanoma/src/resources.ts") },
      { find: /^(sanoma|@sanoma-ai\/app)\/site$/, replacement: src("./packages/app/src/site.ts") },
      { find: /^sanoma\/(data|claims)$/, replacement: src("./packages/sanoma/src/$1.ts") },
      { find: /^(sanoma|@sanoma-ai\/app)\/ui$/, replacement: src("./packages/app/src/ui.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "connectors/*/test/**/*.test.ts", "scripts/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Every spy is undone before the next test, so a test needs no try/finally to put one back.
    restoreMocks: true,
    // The key stored credentials are encrypted with: made up for each run.
    env: {
      SANOMA_SECRETS_KEY: randomBytes(32).toString("base64"),
      SANOMA_SIGNING_KEY: randomBytes(32).toString("base64"),
    },
  },
});
