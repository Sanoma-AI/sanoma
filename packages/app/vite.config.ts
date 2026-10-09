import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { cn as cnTables } from "cn/vite";
import { defineConfig } from "vite";

// The runtime and what it loads stay outside the server bundle: dist/server/server.js imports
// them from the consumer's node_modules, so the app and the worker share one copy. (The app
// imports no connector; a config's connectors reach it only through startApp.)
const RUNTIME = ["@sanoma/workflows", "@dbos-inc/dbos-sdk", "pg", "zod"];

export default defineConfig({
  plugins: [
    // Merge tables fitted to the classes in src (see src/lib/utils.ts), rewritten when they change.
    cnTables({ content: ["src/**/*.tsx"], css: "src/style.css", out: "src/lib/cn-tables.ts" }),
    tailwindcss(),
    tanstackStart({
      // The browser bundle may import only types from the runtime (DBOS, Postgres), and the values
      // of `@sanoma/workflows/shared`. `import type` is erased before resolution, so anything else
      // of these reaching the client is a mistake: fail, in dev as in the build. (Start adds these
      // to its own denials, and to the modules marked server-only, such as server/core.ts.)
      importProtection: {
        behavior: "error",
        client: { specifiers: [/^(@sanoma\/(workflows(?!\/shared$)|connector-|testing)|@dbos-inc\/|pg$)/] },
      },
    }),
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
  server: { port: 3000 },
});
