import { defineConfig } from "vite";

// The main process and the preload, unminified: their stack traces (the shell's log, crashes) stay readable.
export default defineConfig({
  build: { minify: false },
  // Whether this build is signed with a Developer ID (forge.config.mts signs with
  // APPLE_SIGNING_IDENTITY), which updating itself needs (src/self-update.ts).
  define: { SIGNED_WITH_DEVELOPER_ID: JSON.stringify(Boolean(process.env.APPLE_SIGNING_IDENTITY)) },
});
