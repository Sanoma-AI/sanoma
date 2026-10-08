import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The runtime and what it loads stay outside the server bundle: dist/server/server.js imports
// them from the consumer's node_modules, so the app and the worker share one copy. (The app
// imports no connector; a config's connectors reach it only through startApp.)
const RUNTIME = ["@sanoma/workflows", "@dbos-inc/dbos-sdk", "pg", "zod"];

/**
 * The browser bundle may import only types from the runtime (DBOS, Postgres). `import type` is
 * erased before resolution, so any of these reaching the client is a mistake: fail the build.
 */
const browserSafe: Plugin = {
  name: "sanoma:browser-safe",
  applyToEnvironment: (env) => env.name === "client",
  resolveId(id, importer) {
    if (/^(@sanoma\/(workflows|connector-|testing)|@dbos-inc\/|pg$)/.test(id)) {
      this.error(`${id} must not reach the browser bundle (imported by ${importer ?? "?"}); import only its types`);
    }
    return null;
  },
};

export default defineConfig({
  plugins: [browserSafe, tailwindcss(), tanstackStart(), react()],
  environments: {
    ssr: { resolve: { external: RUNTIME } },
  },
  server: { port: 4321 },
});
