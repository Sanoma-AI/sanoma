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
        find: /^sanoma\/workflows\/(cloud-identity|identity-service|kms-secrets|data|describe|description|fake|plugin|shared|scenario|scenarios|wakeup-service)$/,
        replacement: src("./packages/sanoma/workflows/src/$1.ts"),
      },
      { find: /^sanoma\/workflows\/resources$/, replacement: src("./packages/sanoma/workflows/src/constructors.ts") },
      { find: /^sanoma\/workflows\/db$/, replacement: src("./packages/sanoma/workflows/src/db/index.ts") },
      {
        find: /^sanoma\/testing\/(database|features|harness|host|replay|sandbox|scenarios|wakeup)$/,
        replacement: src("./packages/sanoma/testing/src/$1.ts"),
      },
      { find: /^sanoma\/internal\/bridge\/(connector|fake|tfschema)$/, replacement: src("./packages/sanoma/bridge/src/$1.ts") },
      { find: /^sanoma\/app\/build$/, replacement: src("./packages/sanoma/app/src/build.ts") },
      { find: /^sanoma\/app\/steps$/, replacement: src("./packages/sanoma/app/src/steps/index.ts") },
      { find: /^@sanoma-ai\/(workflows|testing|app|bridge)$/, replacement: src("./packages/$1/src/index.ts") },
      {
        find: /^@sanoma-ai\/connector-([a-z0-9-]+)\/(driver|fake|resources|remote|vault)$/,
        replacement: src("./connectors/$1/src/$2.ts"),
      },
      { find: /^@sanoma-ai\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
      { find: /^sanoma$/, replacement: src("./packages/sanoma/src/index.ts") },
      { find: /^sanoma\/resources$/, replacement: src("./packages/sanoma/src/resources.ts") },
      { find: /^sanoma\/secrets$/, replacement: src("./packages/sanoma/src/secrets.ts") },
      { find: /^(sanoma|sanoma\/app)\/site$/, replacement: src("./packages/sanoma/app/src/site.ts") },
      { find: /^sanoma\/(data|claims)$/, replacement: src("./packages/sanoma/src/$1.ts") },
      { find: /^(sanoma|sanoma\/app)\/ui$/, replacement: src("./packages/sanoma/app/src/ui.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "connectors/*/test/**/*.test.ts", "scripts/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Four files at once peak near 60 connections; docker-compose.yml leaves room for several gates.
    maxWorkers: 4,
    // Every spy is undone before the next test, so a test needs no try/finally to put one back.
    restoreMocks: true,
    // The key stored credentials are encrypted with: made up for each run.
    env: {
      SANOMA_SECRETS_KEY: randomBytes(32).toString("base64"),
      SANOMA_SIGNING_KEY: randomBytes(32).toString("base64"),
      // A queued run starts within 50 ms, not DBOS's second, which the tests would otherwise wait out.
      SANOMA_QUEUE_POLL_MS: "50",
    },
  },
});
