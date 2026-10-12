import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveConfig, SanomaClient } from "@sanoma/workflows";
import { loadScenarios } from "@sanoma/workflows/scenario";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrlOf, testRoot } from "../src/index.ts";
import { describeScenarios, runScenario } from "../src/scenarios.ts";
import { config } from "./fixtures/config.ts";

// Needs Postgres: `pnpm db:up`.

// What a company repo's test/scenarios.test.ts holds: a test per scenario in fixtures/scenarios/.
describeScenarios(config);

describe("runScenario", () => {
  // The worker is describeScenarios'; this client shares its database and ledger.
  const shared = { ...config, databaseUrl: testDatabaseUrlOf(config) };
  let client: SanomaClient;
  beforeAll(async () => {
    client = await SanomaClient.connect(shared);
  });
  afterAll(() => client?.close());
  const scenario = (name: string) => loadScenarios(resolveConfig(shared)).scenarios.find((s) => s.name === name)!;

  it("runs the scenario in a sandbox and returns its run id, run, ledger and checks", async () => {
    const launch = scenario("Launch on time");
    const { runId, run, ledger, checks } = await runScenario(launch, { client });
    expect(run).toMatchObject({ runId, status: "finished", sandbox: "Launch on time", startedBy: { id: "scenarios" } });
    expect(ledger.map((r) => r.type)).toContain("scenario.seeded");
    expect(ledger.every((r) => r.runId === runId)).toBe(true);
    expect(checks).toEqual(launch.expect.map((e) => ({ step: e.step, ok: true })));
  });
});

describe("describeScenarios", () => {
  it("throws, naming the root, when it has no scenarios/", () => {
    const root = testRoot("testing_none");
    expect(() => describeScenarios({ ...config, root })).toThrow(
      `describeScenarios found no \`scenarios/\` in ${root}`,
    );
  });

  it("registers a failing test for a file that does not load, naming its file and line", async ({ signal }) => {
    // fixtures/broken.scenarios.ts, in a vitest of its own: its one test fails.
    const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
    const vitestConfig = fileURLToPath(new URL("./fixtures/vitest.config.ts", import.meta.url));
    const args = [vitest, "run", "--config", vitestConfig];
    const child = await promisify(execFile)(process.execPath, args, { signal }).then(
      (out) => ({ code: 0, ...out }),
      (err: { code?: number | string; stdout: string; stderr: string }) => err,
    );
    expect(child.code, `vitest exited with ${child.code}:\n${child.stderr}`).toBe(1);
    const { testResults } = JSON.parse(child.stdout) as {
      testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
    };
    const tests = testResults.flatMap((r) => r.assertionResults);
    expect(tests.map((t) => [t.fullName, t.status])).toEqual([["broken.feature", "failed"]]);
    expect(tests[0]!.failureMessages[0]).toMatch(/^Error: broken\.feature:5: no step matches "the blog is on fire"\n/);
  });
});
