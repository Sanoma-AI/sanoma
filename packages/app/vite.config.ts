import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { cn as cnTables } from "cn/vite";
import { defineConfig, type Plugin } from "vite";

// The runtime and what it loads stay outside the server bundle: dist/server/server.js imports
// them from the consumer's node_modules, so the app and the worker share one copy. (The app
// imports no connector; a config's connectors reach it only through startApp.)
const RUNTIME = ["@sanoma/workflows", "@dbos-inc/dbos-sdk", "pg", "zod"];

/**
 * The browser bundle may import only types from the runtime (DBOS, Postgres), and the values of
 * `@sanoma/workflows/shared`. `import type` is erased before resolution, so anything else of
 * these reaching the client is a mistake: fail the build.
 */
const browserSafe: Plugin = {
  name: "sanoma:browser-safe",
  applyToEnvironment: (env) => env.name === "client",
  resolveId(id, importer) {
    if (/^(@sanoma\/(workflows(?!\/shared$)|connector-|testing)|@dbos-inc\/|pg$)/.test(id)) {
      this.error(`${id} must not reach the browser bundle (imported by ${importer ?? "?"}); import only its types`);
    }
    return null;
  },
};

export default defineConfig({
  plugins: [
    browserSafe,
    // Merge tables fitted to the classes in src (see src/lib/utils.ts), rewritten when they change.
    cnTables({ content: ["src/**/*.tsx"], css: "src/style.css", out: "src/lib/cn-tables.ts" }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
  resolve: {
    alias: [
      // Every `cn` is the one bound to those tables, and cva's clsx is cn's (cn/engine's, which
      // joins arrays and objects as clsx does; cn/lite's joins only strings).
      { find: /^cn$/, replacement: "#/lib/utils.ts" },
      { find: /^clsx$/, replacement: "cn/engine" },
    ],
  },
  environments: {
    ssr: { resolve: { external: RUNTIME } },
  },
  server: { port: 4321 },
});
