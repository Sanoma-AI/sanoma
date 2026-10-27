import { defineConfig } from "vite";

// The main process and the preload, unminified: their stack traces (the shell's log, crashes) stay readable.
export default defineConfig({ build: { minify: false } });
