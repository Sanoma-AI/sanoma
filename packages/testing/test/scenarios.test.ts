import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveConfig, SanomaClient } from "@sanoma/workflows";
import { loadScenarios } from "@sanoma/workflows/scenario";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../src/index.ts";
import { describeScenarios, runScenario } from "../src/scenarios.ts";
import { config } from "./fixtures/config.ts";

// Needs Postgres: `pnpm db:up`.
const appName = "testing_scenarios";
const scenarios = new URL("./fixtures/scenarios/", import.meta.url);

// What a company repo's test/scenarios.test.ts holds: a test per scenario in fixtures/scenarios/.
describeScenarios({ ...config, scenarios, appName });

describe("runScenario", () => {
  // The worker is describeScenarios'; this client shares its database and ledger.
  const shared = { ...config, scenarios, appName, databaseUrl: testDatabaseUrl(appName) };
  let client: SanomaClient;
  beforeAll(async () => {
    client = await SanomaClient.connect(shared);
  });
  afterAll(() => client?.close());
  const scenario = (name: string) => loadScenarios(resolveConfig(shared)).scenarios.find((s) => s.name === name)!;

  it("runs the scenario in a sandbox and returns its run id, run, ledger and checks", async () => {
    const launch = scenario("Launch on time");
    const { runId, run, ledger, checks } = await runScenario(launch, { client, workflows: config.workflows });
    expect(run).toMatchObject({ runId, status: "finished", sandbox: "Launch on time", startedBy: { id: "scenarios" } });
    expect(ledger.map((r) => r.type)).toContain("scenario.seeded");
    expect(ledger.every((r) => r.runId === runId)).toBe(true);
    expect(checks).toEqual(launch.expect.map((e) => ({ step: e.step, ok: true })));
  });

  it("refuses a scenario whose workflow is not in `workflows`", async () => {
    await expect(runScenario(scenario("Launch on time"), { client, workflows: [] })).rejects.toThrow(
      'Scenario "Launch on time" runs announce, which is not in `workflows`',
    );
  });
});

describe("describeScenarios", () => {
  it("throws, naming the directory, when it finds no scenarios", () => {
    const none = new URL("./fixtures/none/", import.meta.url);
    expect(() => describeScenarios({ ...config, scenarios: none, appName })).toThrow(
      `describeScenarios found no scenarios in ${fileURLToPath(none)}`,
    );
  });

  const dir = mkdtempSync(join(tmpdir(), "sanoma-scenarios-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("registers a failing test for a file that does not load, naming its file and line", async () => {
    // fixtures/broken.scenarios.ts, in a vitest of its own: its one test fails.
    const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
    const vitestConfig = fileURLToPath(new URL("./fixtures/vitest.config.ts", import.meta.url));
    const report = join(dir, "report.json");
    const run = promisify(execFile)(process.execPath, [
      vitest,
      "run",
      "--config",
      vitestConfig,
      "--reporter=json",
      `--outputFile=${report}`,
    ]);
    await expect(run).rejects.toMatchObject({ code: 1 });
    const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
      testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
    };
    const tests = testResults.flatMap((r) => r.assertionResults);
    expect(tests.map((t) => [t.fullName, t.status])).toEqual([["broken.feature", "failed"]]);
    expect(tests[0]!.failureMessages[0]).toMatch(/^Error: broken\.feature:5: no step matches "the blog is on fire"\n/);
  });
});
