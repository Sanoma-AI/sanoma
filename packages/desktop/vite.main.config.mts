import { defineConfig } from "vite";

// https://vitejs.dev/config
// Unminified, with source maps: the main process's stack traces (its log, crashes) stay readable.
export default defineConfig({ build: { minify: false, sourcemap: true } });
