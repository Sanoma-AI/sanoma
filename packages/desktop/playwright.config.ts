// The shell's smoke test (`pnpm run test:e2e`). Electron brings its own Chromium: no `playwright install`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  // One shell at a time: each test's has its own --user-data-dir, so two at once would each give a
  // company the same free port from 3100 (`portFor` checks it a start's install before the launcher
  // listens), and one would fail with EADDRINUSE.
  workers: 1,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
