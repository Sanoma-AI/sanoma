import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { readPeople } from "../src/describe.ts";
import {
  allowAll,
  cedarPolicy,
  loadPolicies,
  memoryLedger,
  readPolicyFiles,
  resolveConfig,
  type SanomaConfig,
} from "../src/index.ts";
import { runScenarios } from "../src/scenarios.ts";
import announce from "./fixtures/announce.ts";
import peopleConfig from "./fixtures/people/sanoma.config.ts";
import { marketingFakes } from "./harness.ts";

// Needs Postgres (`pnpm db:up`). A root of its own, with the announce scenarios in its
// scenarios/, compose.feature's in the connectors' own steps among them (the fixtures' review and
// sample features are for workflows defined in other tests).
const root = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
const dir = join(root, "scenarios");
mkdirSync(dir);
for (const file of ["announce.feature", "compose.feature"]) {
  cpSync(fileURLToPath(new URL(`./fixtures/scenarios/${file}`, import.meta.url)), join(dir, file));
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: SanomaConfig = {
  workflows: [announce],
  connectors: marketingFakes().connectors,
  policy: allowAll,
  ledger: memoryLedger(),
  root,
};
const databaseUrl = testDatabaseUrl("workflows_scenarios");

describe("runScenarios", () => {
  it("runs every scenario of the config as a sandbox run, names those that passed, and prints nothing of their failures", async () => {
    writeFileSync(
      join(dir, "rejected.feature"),
      [
        "Feature: Rejected",
        "  Scenario: A rejected review publishes nothing",
        "    When announce runs with",
        "      | title    | Nope                 |",
        "      | launchAt | 2030-01-01T09:00:00Z |",
        '    And "Review launch copy" is rejected by marketing-lead',
        "    Then ghost.post.publish was not called",
        '    And the run fails with "approval_rejected"',
        "",
      ].join("\n"),
    );
    onTestFinished(() => rmSync(join(dir, "rejected.feature")));
    const printed = [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "log")];
    const log: string[] = [];
    const result = await runScenarios(config, { databaseUrl, log: (l) => log.push(l) });
    expect(result).toEqual({
      passed: [
        "Launch on time",
        "Publish retried",
        "The newsletter fails to send",
        "A rejected review publishes nothing",
      ],
      failed: [],
    });
    expect(log).toEqual([
      "passed announce.feature › Launch on time",
      "passed announce.feature › Publish retried",
      "passed compose.feature › The newsletter fails to send",
      "passed rejected.feature › A rejected review publishes nothing",
    ]);
    // "Publish retried" fails a try on purpose, and the rejected run fails as it should.
    const lines = printed.flatMap((spy) => spy.mock.calls.flat().map(String));
    expect(lines.filter((l) => /error in step|rejected|DriverError|Error:/i.test(l))).toEqual([]);
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
      expect(passed).toEqual(["Publish retried", "The newsletter fails to send"]);
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
    await expect(runScenarios({ ...config, root: join(root, "elsewhere") }, { databaseUrl })).resolves.toEqual({
      passed: [],
      failed: [],
    });
  });
});

describe("runScenarios with people and a Cedar policy", () => {
  // The people fixture: its policy made from policies/*.cedar, as the launcher makes it.
  const resolved = resolveConfig(peopleConfig);
  const policy = cedarPolicy(
    resolved,
    loadPolicies(readPolicyFiles(resolved.root!)).policies,
    readPeople(resolved.root).people,
  );

  it("starts each run as the person or agent acting, and checks the hold for a group and the denial's reason", async () => {
    await expect(runScenarios({ ...peopleConfig, policy }, { databaseUrl })).resolves.toEqual({
      passed: ["A large refund waits for finance", "An agent refunds nothing"],
      failed: [],
    });
  });
});
