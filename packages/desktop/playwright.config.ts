// The shell's smoke test (test/e2e): Electron itself, started from the build, against a fixture
// company whose launcher is a fake. Not part of the root `pnpm test` (vitest), and CI runs it only
// for changes here (.github/workflows/desktop.yml). Electron brings its own Chromium: no
// `playwright install`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  // The steps wait up to 45 s (install and start) and 15 s (stop), then quit stops the shell.
  timeout: 120_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
