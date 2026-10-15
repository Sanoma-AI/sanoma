import { type RunSummary, SanomaClient } from "./client.ts";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import type { Principal } from "./define.ts";
import { type LedgerRecord, memoryLedger } from "./ledger.ts";
import { type Check, check, drive, loadScenarios, type Scenario, type Scope } from "./scenario.ts";
import { errorMessage } from "./shared.ts";
import { startWorker } from "./worker.ts";

/*
 * `@sanoma-ai/workflows/scenarios`: runs a config's scenarios as sandbox runs, with no test
 * framework. Server-side only, like `./scenario`: it loads Cucumber and starts a worker.
 * `sanoma check` runs every scenario through `runScenarios`; `@sanoma-ai/testing/scenarios` wraps
 * `runScenario` in a vitest test per scenario.
 */

export interface RunScenarioOptions {
  /** A client of the worker that runs the scenario, whose connectors carry the fakes and whose root has the scenarios. */
  client: SanomaClient;
  /** What the scenario was loaded from (`loadScenarios`), whose feature files its run is checked against: the resolved config. */
  scope: Scope;
  /** Who starts the run. Defaults to `{ id: "scenarios" }`. */
  startedBy?: Principal;
  /** How long the run may take, passed to `drive`. */
  timeoutMs?: number;
}

/**
 * Runs a scenario as a sandbox run: starts its workflow with its input, decides its approvals
 * as it says, and checks the run's ledger against it (`check`: Cucumber runs its `Then` steps).
 */
export async function runScenario(
  scenario: Scenario,
  { client, scope, startedBy = { id: "scenarios" }, timeoutMs }: RunScenarioOptions,
): Promise<{ runId: string; run: RunSummary; ledger: LedgerRecord[]; checks: Check[] }> {
  const runId = await client.start(scenario.workflow, scenario.input, { startedBy, sandbox: scenario.name });
  const run = await drive(client, runId, scenario, { timeoutMs });
  const ledger = await client.ledger(runId);
  return { runId, run, ledger, checks: await check(scope, scenario, ledger) };
}

/** One step of a scenario that did not hold, or a file whose scenarios could not be read (`step` is then `did not load`). */
export interface ScenarioFailure {
  /** The scenario's name, or the feature file's for one that did not load. */
  scenario: string;
  step: string;
  message: string;
}

export interface RunScenariosOptions {
  /** The Postgres the worker and the client run on, instead of the config's: a database of its own. */
  databaseUrl: string;
  /** Who starts the runs. Defaults to `{ id: "scenarios" }`. */
  startedBy?: Principal;
  /** How long each run may take (`drive`'s; 15 seconds by default). */
  timeoutMs?: number;
  /** Receives a line per scenario as it ends. */
  log?: (line: string) => void;
}

/**
 * Runs every scenario in `scenarios/` in the config's root, one after another, as sandbox runs
 * on a worker it starts on `databaseUrl` with an in-memory ledger (the config's `ledger` is not
 * written), and stops when done. `passed` names the scenarios whose every check held; `failed`
 * has one entry per step that did not, with `check`'s detail, and one per feature file that
 * could not be read, with why. A scenario whose run cannot be driven to its end (an approval
 * with no decision, a run still going after `timeoutMs`) fails with that error at its `When`
 * step. A config whose root has no `scenarios/`, or none in it, passes nothing and fails nothing.
 */
export async function runScenarios(
  config: SanomaConfig,
  { databaseUrl, startedBy, timeoutMs, log }: RunScenariosOptions,
): Promise<{ passed: string[]; failed: ScenarioFailure[] }> {
  const shared: SanomaConfig = { ...config, databaseUrl, ledger: memoryLedger() };
  const resolved = resolveConfig(shared);
  const { scenarios, errors } = await loadScenarios(resolved);
  const failed: ScenarioFailure[] = errors.map(({ file, message }) => ({
    scenario: file,
    step: "did not load",
    message,
  }));
  const passed: string[] = [];
  if (scenarios.length === 0) return { passed, failed };

  // Quiet: the scenarios call the fakes alone, so no vendor need be configured.
  const worker = await startWorker(shared, { promote: true, quiet: true });
  try {
    const client = await SanomaClient.connect(shared);
    try {
      for (const scenario of scenarios) {
        const before = failed.length;
        try {
          const { checks } = await runScenario(scenario, { client, scope: resolved, startedBy, timeoutMs });
          for (const c of checks) {
            if (!c.ok) failed.push({ scenario: scenario.name, step: c.step, message: c.detail ?? "did not hold" });
          }
        } catch (err) {
          const when = scenario.steps.find((s) => s.kind === "when")?.text ?? `${scenario.workflow} runs`;
          failed.push({ scenario: scenario.name, step: when, message: errorMessage(err) });
        }
        const ok = failed.length === before;
        if (ok) passed.push(scenario.name);
        log?.(`${ok ? "passed" : "failed"} ${scenario.file} › ${scenario.name}`);
      }
    } finally {
      await client.close();
    }
  } finally {
    await worker.stop();
  }
  return { passed, failed };
}
