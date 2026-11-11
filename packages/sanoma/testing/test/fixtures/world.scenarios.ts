import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "../../src/index.ts";
import { describeScenarios } from "../../src/scenarios.ts";
import { config } from "./config.ts";

// Run by scenarios.test.ts in a vitest of its own (vitest.config.ts here), beside broken.scenarios.ts:
// a root whose scenarios/ holds the world alone, which seeds a demo, is one test, its Givens seeded.
await describeScenarios(
  { ...config, root: fileURLToPath(new URL("./world/", import.meta.url)) },
  { databaseUrl: testDatabaseUrl("testing_world") },
);
