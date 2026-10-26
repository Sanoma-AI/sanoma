import { type RunSummary, SanomaClient } from "./client.ts";
import { resolveConfig, type SanomaConfig } from "./config.ts";
import type { Principal } from "./define.ts";
import { type LedgerRecord, memoryLedger } from "./ledger.ts";
import { type Check, check, drive, loadScenarios, type Scenario, type Scope } from "./scenario.ts";
import { errorMessage } from "./shared.ts";
import { startWorker } from "./worker.ts";

export { type DemoState, demoState, reseed } from "./demo.ts";

/*
 * `@sanoma-ai/workflows/scenarios`: runs a config's scenarios as sandbox runs, with no test
 * framework. Server-side only, like `./scenario`: it loads Cucumber and starts a worker.
 * `sanoma check` runs every scenario through `runScenarios`; `@sanoma-ai/testing/scenarios` wraps
 * `runScenario` in a vitest test per scenario. A demo seeds its instance with `reseed`.
 */

export interface RunScenarioOptions {
  /** A client of the worker that runs the scenario, whose connectors carry the fakes and whose root has the scenarios. */
  client: SanomaClient;
  /** What the scenario was loaded from (`loadScenarios`), whose feature files its run is checked against: the resolved config. */
  scope: Scope;
  /**
   * Who starts the run, by id (`"ada"` or `{ id: "ada" }`), unless the scenario says who is acting.
   * Defaults to `scenarios`, one of the runtime's own agents.
   */
  startedBy?: Principal | string;
  /** How long the run may take, passed to `drive`. */
  timeoutMs?: number;
}

/**
 * Runs a scenario as a sandbox run: starts its workflow with its input, as whoever it says is
 * acting, decides its approvals as it says, and checks the run's ledger against it (`check`:
 * Cucumber runs its `Then` steps). Refuses a world, which runs nothing.
 */
export async function runScenario(
  scenario: Scenario,
  { client, scope, startedBy = "scenarios", timeoutMs }: RunScenarioOptions,
): Promise<{ runId: string; run: RunSummary; ledger: LedgerRecord[]; checks: Check[] }> {
  if (scenario.workflow === undefined) {
    throw new Error(`Scenario "${scenario.name}" is a world: it seeds a demo's instance, and runs nothing`);
  }
  const runId = await client.start(scenario.workflow, scenario.input, {
    startedBy: scenario.startedBy ?? startedBy,
    sandbox: scenario.name,
  });
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
  /** Who starts the runs whose scenario does not say who is acting (`runScenario`'s). */
  startedBy?: Principal | string;
  /** How long each run may take (`drive`'s; 15 seconds by default). */
  timeoutMs?: number;
  /** Receives a line per scenario as it ends. */
  log?: (line: string) => void;
}

/**
 * True for a scenario that is a test: one that runs a workflow (not a world), and not a moment
 * that decides nothing, which a demo leaves waiting at its first approval.
 */
export const isTest = (scenario: Scenario): scenario is Scenario & { workflow: string } =>
  scenario.workflow !== undefined && !(scenario.moment && scenario.decisions.length === 0);

/**
 * Runs every scenario in `scenarios/` in the config's root, one after another, as sandbox runs
 * on a worker it starts on `databaseUrl` with an in-memory ledger (the config's `ledger` is not
 * written), and stops when done. `passed` names the scenarios whose every check held; `failed`
 * has one entry per step that did not, with `check`'s detail, and one per feature file that
 * could not be read, with why. A scenario whose run cannot be driven to its end (an approval
 * with no decision, a run still going after `timeoutMs`) fails with that error at its `When`
 * step. A config whose root has no `scenarios/`, or none in it, passes nothing and fails nothing.
 * Worlds and moments that decide nothing are no tests (`isTest`): they are left out, each logged as skipped.
 */
export async function runScenarios(
  config: SanomaConfig,
  { databaseUrl, startedBy, timeoutMs, log }: RunScenariosOptions,
): Promise<{ passed: string[]; failed: ScenarioFailure[] }> {
  const shared: SanomaConfig = { ...config, databaseUrl, ledger: memoryLedger() };
  const resolved = resolveConfig(shared);
  const { scenarios: loaded, errors } = await loadScenarios(resolved);
  const scenarios = loaded.filter(isTest);
  for (const s of loaded) if (!isTest(s)) log?.(`skipped ${s.file} › ${s.name}: ${s.moment ? "a moment" : "a world"}`);
  const failed: ScenarioFailure[] = errors.map(({ file, message }) => ({
    scenario: file,
    step: "did not load",
    message,
  }));
  const passed: string[] = [];
  if (scenarios.length === 0) return { passed, failed };

  // Quiet: the scenarios call the fakes alone, so no vendor need be configured; and no schedule
  // is applied, since a tick's run would be live.
  const worker = await startWorker(shared, { promote: true, quiet: true, schedules: false });
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
