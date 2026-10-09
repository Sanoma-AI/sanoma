// The tests are named after the feature files and scenarios, and one for a file that does not load fails by throwing.
/* oxlint-disable vitest/valid-title, vitest/expect-expect */
import { fileURLToPath } from "node:url";
import {
  type LedgerRecord,
  memoryLedger,
  type Principal,
  resolveConfig,
  type RunSummary,
  SanomaClient,
  type SanomaConfig,
  type Worker,
} from "@sanoma/workflows";
import { type Check, check, drive, loadScenarios, type Scenario } from "@sanoma/workflows/scenario";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestWorker, testDatabaseUrl, type TestWorkerOptions } from "./index.ts";

export interface RunScenarioOptions {
  /** A client of the worker that runs the scenario, which has the config's `fakes` and `scenarios`. */
  client: SanomaClient;
  /** The config's workflows, one of which the scenario runs. */
  workflows: SanomaConfig["workflows"];
  /** Who starts the run. Defaults to `{ id: "scenarios" }`. */
  startedBy?: Principal;
  /** How long the run may take, passed to `drive`. */
  timeoutMs?: number;
}

/**
 * Runs a scenario as a sandbox run: starts its workflow with its input, decides its approvals
 * as it says, and checks its expectations against the run's ledger.
 */
export async function runScenario(
  scenario: Scenario,
  { client, workflows, startedBy = { id: "scenarios" }, timeoutMs }: RunScenarioOptions,
): Promise<{ runId: string; run: RunSummary; ledger: LedgerRecord[]; checks: Check[] }> {
  const workflow = workflows.find((w) => w.name === scenario.workflow);
  if (!workflow) {
    throw new Error(`Scenario "${scenario.name}" runs ${scenario.workflow}, which is not in \`workflows\``);
  }
  const runId = await client.start(workflow, scenario.input, { startedBy, sandbox: scenario.name });
  const run = await drive(client, runId, scenario, { timeoutMs });
  const ledger = await client.ledger(runId);
  return { runId, run, ledger, checks: check(scenario, ledger) };
}

/**
 * Registers a vitest test for each scenario in the config's `scenarios` directory, in a
 * `describe` per feature file, that runs it and expects every check to pass; and a failing test
 * for each file that does not load. Starts one test worker for the scenarios, before them, and
 * stops it after. `config` and `options` are `startTestWorker`'s; `startedBy` starts the runs, and
 * `timeoutMs` is how long each may take (`drive`'s).
 */
export function describeScenarios(
  config: Parameters<typeof startTestWorker>[0],
  { startedBy, timeoutMs, ...options }: TestWorkerOptions & { startedBy?: Principal; timeoutMs?: number } = {},
): void {
  // The worker and the client share the ledger and the database, so the client reads the runs.
  const shared = {
    ...config,
    ledger: config.ledger ?? memoryLedger(),
    databaseUrl: options.databaseUrl ?? testDatabaseUrl(config.appName),
  };
  const resolved = resolveConfig(shared);
  if (!resolved.scenarios) throw new Error("describeScenarios needs the config's `scenarios` directory");
  const { scenarios, errors } = loadScenarios(resolved);
  // A mistyped directory loads nothing, and a test file that registers no tests would pass.
  if (scenarios.length === 0 && errors.length === 0) {
    throw new Error(`describeScenarios found no scenarios in ${fileURLToPath(resolved.scenarios)}`);
  }
  for (const { file, message } of errors) {
    it(file, () => {
      throw new Error(message);
    });
  }
  if (scenarios.length === 0) return;

  let worker: Worker | undefined;
  let client: SanomaClient | undefined;
  // Each test gets twice drive's deadline (15 s by default), so drive's error, naming what the run
  // waits on, is the one reported rather than vitest's timeout.
  const testTimeout = (timeoutMs ?? 15_000) * 2;
  beforeAll(async () => {
    worker = await startTestWorker(shared, options);
    client = await SanomaClient.connect(shared);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await worker?.stop();
  });

  for (const [file, inFile] of Map.groupBy(scenarios, (s) => s.file)) {
    describe(file, () => {
      for (const scenario of inFile) {
        it(
          scenario.name,
          async () => {
            if (!client) throw new Error("The scenarios' worker did not start");
            const { checks } = await runScenario(scenario, {
              client,
              workflows: config.workflows,
              startedBy,
              timeoutMs,
            });
            const failed = checks.filter((c) => !c.ok);
            const lines = failed.map((c) => `  ${c.step}: ${c.detail}`);
            expect(failed, [`${file}: "${scenario.name}" failed:`, ...lines].join("\n")).toEqual([]);
          },
          testTimeout,
        );
      }
    });
  }
}
