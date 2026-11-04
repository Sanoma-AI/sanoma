import { defineConfig } from "vite";

// The main process and the preload, unminified: their stack traces (the shell's log, crashes) stay readable.
export default defineConfig({
  build: { minify: false },
  // Whether this build is signed for release (forge.config.mts signs with APPLE_SIGNING_IDENTITY, or
  // on Windows with WINDOWS_SIGN_WITH_PARAMS), which updating itself needs (src/self-update.ts).
  define: {
    SIGNED_BUILD: JSON.stringify(Boolean(process.env.APPLE_SIGNING_IDENTITY || process.env.WINDOWS_SIGN_WITH_PARAMS)),
  },
});
