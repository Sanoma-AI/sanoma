// The tests are named after the feature files and scenarios, and one for a file that does not load fails by throwing.
/* oxlint-disable vitest/valid-title, vitest/expect-expect */
import { fileURLToPath } from "node:url";
import { memoryLedger, type Principal, resolveConfig, type SanomaConfig } from "@sanoma/workflows";
import { loadScenarios } from "@sanoma/workflows/scenario";
import { runScenario } from "@sanoma/workflows/scenarios";
import { describe, expect, it } from "vitest";
import { useTestApp } from "./harness.ts";
import type { TestWorkerOptions } from "./index.ts";

// One scenario as a sandbox run, from `@sanoma/workflows/scenarios`, where `runScenarios` (what
// `sanoma check` runs) is built on it too.
export { runScenario, type RunScenarioOptions } from "@sanoma/workflows/scenarios";

/**
 * Registers a vitest test for each scenario in `scenarios/` in the config's root, in a
 * `describe` per feature file, that runs it (`runScenario`) and expects every check to pass; and
 * a failing test for each file that does not load. Starts one test app (`useTestApp`) for the
 * scenarios, before them, and stops it after. `config` and `options` are `startTestWorker`'s;
 * `startedBy` starts the runs, and `timeoutMs` is how long each may take (`drive`'s). Cucumber
 * compiles the feature files first, so the test file awaits it at its top level:
 * `await describeScenarios(config, { databaseUrl })`.
 */
export async function describeScenarios(
  config: SanomaConfig,
  { startedBy, timeoutMs, ...options }: TestWorkerOptions & { startedBy?: Principal; timeoutMs?: number },
): Promise<void> {
  // Only to read the scenarios: the test app resolves the config the worker runs.
  const resolved = resolveConfig({ ...config, ledger: config.ledger ?? memoryLedger() });
  if (!resolved.scenarios) {
    throw new Error(
      resolved.root === undefined
        ? "describeScenarios needs the config's `root`, whose `scenarios/` holds the scenarios"
        : `describeScenarios found no \`scenarios/\` in ${resolved.root}`,
    );
  }
  const { scenarios, errors } = await loadScenarios(resolved);
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

  const app = useTestApp(config, options);
  // Each test gets twice drive's deadline (15 s by default), so drive's error, naming what the run
  // waits on, is the one reported rather than vitest's timeout.
  const testTimeout = (timeoutMs ?? 15_000) * 2;

  for (const [file, inFile] of Map.groupBy(scenarios, (s) => s.file)) {
    describe(file, () => {
      for (const scenario of inFile) {
        it(
          scenario.name,
          async () => {
            const { checks } = await runScenario(scenario, {
              client: app.client,
              scope: resolved,
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
