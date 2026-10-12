import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { testDatabaseUrl } from "@sanoma/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowAll, memoryLedger, type SanomaConfig } from "../src/index.ts";
import { runScenarios } from "../src/scenarios.ts";
import announce from "./fixtures/announce.ts";
import { marketingFakes } from "./harness.ts";

// Needs Postgres (`pnpm db:up`). The announce scenarios, in a directory of their own (the
// fixtures' review and sample features are for workflows defined in other tests).
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
  cpSync(
    fileURLToPath(new URL("./fixtures/scenarios/announce.feature", import.meta.url)),
    join(dir, "announce.feature"),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const vendors = marketingFakes();
const config: SanomaConfig = {
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: vendors.drivers,
  fakes: [vendors.ghost, vendors.resend, vendors.bluesky],
  get scenarios() {
    return pathToFileURL(`${dir}/`);
  },
  policy: allowAll,
  ledger: memoryLedger(),
  appName: "workflows-scenarios",
};
const databaseUrl = testDatabaseUrl("workflows_scenarios");

describe("runScenarios", () => {
  it("runs every scenario of the config as a sandbox run and names those that passed", async () => {
    const log: string[] = [];
    const result = await runScenarios(config, { databaseUrl, log: (l) => log.push(l) });
    expect(result).toEqual({ passed: ["Launch on time", "Publish retried"], failed: [] });
    expect(log).toEqual(["passed announce.feature › Launch on time", "passed announce.feature › Publish retried"]);
  });

  it("reports each step that did not hold, with the scenario, and each file that did not load", async () => {
    const feature = join(dir, "announce.feature");
    const text = readFileSync(feature, "utf8");
    writeFileSync(
      feature,
      text.replace(
        "    And the run succeeds\n\n  Scenario: Publish retried",
        "    And the run fails\n\n  Scenario: Publish retried",
      ),
    );
    writeFileSync(
      join(dir, "broken.feature"),
      "Feature: Broken\n  Scenario: On fire\n    When announce runs\n    Then the blog is on fire\n",
    );
    try {
      const { passed, failed } = await runScenarios(config, { databaseUrl });
      expect(passed).toEqual(["Publish retried"]);
      expect(failed).toEqual([
        {
          scenario: "broken.feature",
          step: "did not load",
          message: expect.stringMatching(/^broken\.feature:4: no step matches "the blog is on fire"/),
        },
        { scenario: "Launch on time", step: "the run fails", message: "the run finished" },
      ]);
    } finally {
      writeFileSync(feature, text);
      rmSync(join(dir, "broken.feature"));
    }
  });

  it("passes and fails nothing for a config with no scenarios", async () => {
    await expect(runScenarios({ ...config, scenarios: undefined }, { databaseUrl })).resolves.toEqual({
      passed: [],
      failed: [],
    });
  });
});
