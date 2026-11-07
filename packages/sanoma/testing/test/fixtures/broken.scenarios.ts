import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "../../src/index.ts";
import { describeScenarios } from "../../src/scenarios.ts";
import { config } from "./config.ts";

// Run by scenarios.test.ts in a vitest of its own (vitest.config.ts here), since its test fails.
// It starts no worker: its one file does not load, so it has no scenario to run.
await describeScenarios(
  { ...config, root: fileURLToPath(new URL("./broken/", import.meta.url)) },
  { databaseUrl: testDatabaseUrl("testing_broken") },
);
