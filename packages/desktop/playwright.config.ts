// The shell's smoke test (`pnpm run test:e2e`). Electron brings its own Chromium: no `playwright install`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
