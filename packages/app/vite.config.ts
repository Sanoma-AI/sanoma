import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the page into dist/ui, which the server serves. React is bundled in, so the
// published package has no runtime dependencies. `pnpm dev:ui` serves the page with hot
// reload and sends /api to an app started on the suggested port.
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4321" } },
});
