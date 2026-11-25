import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "sanoma/testing";
import { describeScenarios } from "sanoma/testing/scenarios";
import { defineWorkflow, memoryLedger, type SanomaConfig } from "sanoma/workflows";
import { z } from "zod";
import { agent37 } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. `agent37Steps`' Given seeds the fake through a scenario, as a
// company's sandbox run does: with the workspace's limit at 0, opening a box is refused with 409;
// without it, the same run opens one.

const openBox = defineWorkflow({
  name: "open-box",
  trigger: "manual",
  input: z.object({ name: z.string() }),
  uses: [agent37.box.open],
  run: async (ctx, { name }) => ctx.agent37.box.open({ name, group: "acme", ttl: 60 }),
});

const root = mkdtempSync(join(tmpdir(), "agent37-scenario-"));
mkdirSync(join(root, "scenarios"));
writeFileSync(
  join(root, "scenarios", "limit.feature"),
  `Feature: Agent37's limit of awake instances

  Scenario: Past the workspace's limit
    Given Agent37's workspace keeps at most 0 instances awake
    When open-box runs with
      | name | sanoma-busy |
    Then it fails with status 409
    And the run fails

  Scenario: Under it
    When open-box runs with
      | name | sanoma-free |
    Then agent37.box.open was called
    And the run succeeds
`,
);

const config = {
  workflows: [openBox],
  connectors: [agent37],
  ledger: memoryLedger(),
  root,
} satisfies SanomaConfig;

await describeScenarios(config, { databaseUrl: testDatabaseUrl("agent37_scenario") });
