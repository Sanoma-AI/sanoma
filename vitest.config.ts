import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

/** The condition packages/sanoma/package.json's `exports` name each entry's source under. */
const SOURCE = "sanoma-source";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The workspace's other packages from source. Keep in sync with `paths` in tsconfig.json.
    alias: [
      { find: /^@sanoma-ai\/invoices\/pdf-contract$/, replacement: src("./packages/invoices/src/render-contract.ts") },
      { find: /^@sanoma-ai\/invoices\/pdf$/, replacement: src("./packages/invoices/src/pdf.tsx") },
      { find: /^@sanoma-ai\/invoices\/browser$/, replacement: src("./packages/invoices/src/browser.ts") },
      { find: /^@sanoma-ai\/invoices\/node$/, replacement: src("./packages/invoices/src/node.ts") },
      { find: /^@sanoma-ai\/invoices$/, replacement: src("./packages/invoices/src/index.ts") },
      { find: /^@sanoma-ai\/invoices\/examples$/, replacement: src("./packages/invoices/src/examples.ts") },
      {
        find: /^@sanoma-ai\/connector-([a-z0-9-]+)\/(driver|fake|resources|remote|vault)$/,
        replacement: src("./connectors/$1/src/$2.ts"),
      },
      { find: /^@sanoma-ai\/connector-([a-z0-9-]+)$/, replacement: src("./connectors/$1/src/index.ts") },
    ],
  },
  // `sanoma` and its subpaths from source, as in tsconfig.json: the tests run as Vite's server code, so its
  // default server conditions and this one.
  ssr: { resolve: { conditions: [SOURCE, ...defaultServerConditions] } },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/sanoma/*/test/**/*.test.{ts,tsx}",
      "connectors/*/test/**/*.test.ts",
      "scripts/*.test.ts",
    ],
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
