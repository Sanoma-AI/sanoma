import { join } from "node:path";
import { defineConfig } from "vite";

// The shell's own pages, plain HTML and JavaScript in start/: two pages (the start screen, a
// company's progress), one renderer (`start`).
// Forge's output folder is set again, as `root` would move it under start/.
const start = join(import.meta.dirname, "start");
export default defineConfig({
  root: start,
  build: {
    // As files, not data: URLs, which the pages' Content-Security-Policy refuses (the mark's drawing).
    assetsInlineLimit: 0,
    outDir: join(import.meta.dirname, ".vite", "renderer", "start"),
    rollupOptions: { input: [join(start, "index.html"), join(start, "company.html")] },
  },
});
