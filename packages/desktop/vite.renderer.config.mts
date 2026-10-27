import { join } from "node:path";
import { defineConfig } from "vite";

// The shell's own pages, plain HTML and JavaScript in start/: two pages, one renderer (`start`).
// Forge's output folder is set again, as `root` would move it under start/.
const start = join(import.meta.dirname, "start");
export default defineConfig({
  root: start,
  build: {
    outDir: join(import.meta.dirname, ".vite", "renderer", "start"),
    rollupOptions: { input: [join(start, "index.html"), join(start, "company.html")] },
  },
});
