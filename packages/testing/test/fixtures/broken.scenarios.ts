import { fileURLToPath } from "node:url";
import { describeScenarios } from "../../src/scenarios.ts";
import { config } from "./config.ts";

// Run by scenarios.test.ts in a vitest of its own (vitest.config.ts here), since its test fails.
describeScenarios({ ...config, root: fileURLToPath(new URL("./broken/", import.meta.url)) });
