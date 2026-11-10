import { DBOS } from "@dbos-inc/dbos-sdk";
import { indexDrivers, sandboxDrivers } from "./config.ts";
import { CALL_WORKFLOW, CallInput } from "./call-workflow.ts";
import { opIdsOf } from "./define.ts";
import { SanomaError } from "./errors.ts";
import { connectionFakes } from "./fake.ts";
import { applyGivens, refuseUnfaked } from "./givens.ts";
import type { ConnectionCatalog, ConnectionRef, ConnectionSnapshot } from "./connection.ts";
import { entry, write } from "./ledger.ts";
import type { DriverFn } from "./op.ts";
import type { Run } from "./run.ts";
import { memorySecrets } from "./secret.ts";
import { writeRunChecks } from "./db.ts";
import { warn } from "./log.ts";
import { check, loadScenarios, type RunChecks } from "./scenario.ts";
import { errorMessage, notLoaded } from "./shared.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/** Declared accounts get synthetic identities in each run; no production metadata or secrets are read. */
export function sandboxConnection(catalog: ConnectionCatalog, runId: string) {
  return (vendor: string, ref?: ConnectionRef): ConnectionSnapshot | undefined => {
    const definitions = [...catalog.definitions.values()].filter((d) => d.vendor === vendor);
    const selected = ref ?? definitions.find((d) => d.default);
    if (!selected && !Object.keys(catalog.methods.get(vendor) ?? {}).length) return undefined;
    const definition = selected && catalog.definitions.get(selected.$connection);
    if (!definition || selected?.vendor !== vendor || definition.vendor !== vendor)
      throw new SanomaError("invalid_input", "Select an explicitly declared sandbox connection");
    const revision = `sandbox:${runId}:${definition.$connection}`;
    if (selected.revision !== undefined && selected.revision !== revision)
      throw new SanomaError("invalid_input", "A sandbox cannot use a production connection revision");
    return {
      id: definition.$connection,
      vendor,
      method: definition.method,
      account: definition.account ?? `fake:${definition.$connection}`,
      scopes: [...definition.scopes],
      revision,
      definition: revision,
    };
  };
}

/**
 * Seeds a sandbox run of the scenario `name`, from the worker, in one step: reads the scenario,
 * checks that it runs this workflow, makes the run's own fakes (each vendor's maker, called once
 * for the run), checks that every operation the workflow uses or the scenario seeds has one and
 * that every resource it seeds has a fake holding resources, calls each `Given` operation
 * through them, puts or removes each `Given` resource in them, injects the faults into them,
 * then puts their functions on the run. The run then calls those only, so sandbox runs share no
 * state when the makers make a new fake each. The step's checkpoint never stands in for them: a
 * run whose seeding is replayed from it has none, and fails, since a sandbox run does not
 * survive a worker restart.
 */
export async function seedSandbox(run: Run, name: string, input: unknown): Promise<void> {
  const { state } = run;
  let copies: Map<string, DriverFn> | undefined;
  // The run's secrets, in memory as its fakes are: seeding and its calls share them.
  const secrets = memorySecrets();
  const { seeds } = await DBOS.runStep(
    async () => {
      // Read in the step, so a recovered run never reads a feature file edited or renamed since.
      const { scenarios, errors } = await loadScenarios(state);
      const scenario = scenarios.find((s) => s.name === name);
      if (!scenario) {
        throw new SanomaError("invalid_input", `No scenario named "${name}"${notLoaded(errors)}`, {
          scenario: name,
        });
      }
      if (scenario.workflow !== run.workflow) {
        throw new SanomaError("invalid_input", `Scenario "${name}" runs ${scenario.workflow}, not ${run.workflow}`, {
          scenario: name,
          workflow: scenario.workflow,
        });
      }
      const fakes = new Map([...state.fakes].map(([vendor, make]) => [vendor, make()]));
      const named = new Map(
        [...state.fakes]
          .filter(([vendor]) => Object.keys(state.connections!.catalog.methods.get(vendor) ?? {}).length)
          .map(([vendor, make]) => [vendor, connectionFakes(make)]),
      );
      const select = sandboxConnection(state.connections!.catalog, run.id);
      run.fakeConnection = select;
      // The built-ins first, so a connector's fake that implements one of their operations wins.
      const drivers = indexDrivers(
        [...sandboxDrivers(state.ops), ...Array.from(fakes, ([vendor, f]) => named.get(vendor)?.driver ?? f.driver)],
        state.ops,
        { sandbox: true },
      );
      // The built-in call workflow selects exactly one operation. Other direct operations
      // (including live connection mutations) need no fake unless this scenario calls them,
      // which `applyGivens` checks.
      const uses =
        run.workflow === CALL_WORKFLOW ? [CallInput.parse(input).op] : opIdsOf(state.workflows.get(run.workflow)!);
      refuseUnfaked(`A sandbox run of ${run.workflow} calls`, uses, drivers, { scenario: name });
      /** The run's fake of `vendor`, or of the account `ref` selects. */
      const fakeOf = (vendor: string, ref?: ConnectionRef) => {
        const selected = select(vendor, ref);
        return selected ? named.get(vendor)!.account({ vendor, $connection: selected.id }) : fakes.get(vendor)!;
      };
      const seeded = await applyGivens(scenario, {
        drivers,
        fakes,
        fakeOf,
        ops: state.ops,
        call: (i, opId, ref) => ({
          idempotencyKey: `${run.id}:seed:${i}`,
          runId: run.id,
          opId,
          attempt: 1,
          secrets,
          connection: select(state.ops.get(opId)!.vendor, ref),
        }),
      });
      copies = drivers;
      return { seeds: seeded };
    },
    { name: "sandbox:seed" },
  );
  if (!copies) {
    // Replayed from its checkpoint (after a worker restart, or in a fork), so the run has no fakes.
    // The records written before the restart hold the seqs from here on: the failure goes after them.
    run.seq = Math.max(run.seq, ...(await state.ledger.read(run.id)).map((r) => r.seq + 1));
    throw new SanomaError(
      "invalid_input",
      `Sandbox run ${run.id} was interrupted by a worker restart and the fakes' state is gone; start the scenario again`,
      { runId: run.id, scenario: name },
    );
  }
  run.fakeDrivers = copies;
  run.fakeSecrets = secrets;
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}

/**
 * A seeded sandbox run's checks against its ledger so far, written for the app (`writeRunChecks`):
 * Cucumber runs its scenario's Then steps over the feature file as it reads now, which the agent
 * may have changed since. Called when the run waits and when it ends (`recordSandboxChecks`); a
 * check met is settled when what it expects stays so (a call made, a decision recorded), and every
 * one once the run has ended, which the app reads from the run's status. No step and no ledger
 * record, so a replay neither depends on it nor differs by it: a failure is warned about, and the
 * run goes on.
 */
export async function recordChecks(run: Run, name: string): Promise<void> {
  if (!run.fakeDrivers) return;
  const { state } = run;
  try {
    const checks = await checksOf(run, name).catch((err: unknown): RunChecks => ({ error: errorMessage(err) }));
    await writeRunChecks(await state.db(), run.id, checks);
  } catch (err) {
    warn(`run ${run.id}: could not record its checks against scenario "${name}": ${errorMessage(err)}`);
  }
}

async function checksOf({ id, state }: Run, name: string): Promise<RunChecks> {
  const loaded = await loadScenarios(state);
  const scenario = loaded.scenarios.find((s) => s.name === name);
  if (!scenario) return { error: `The feature files no longer have scenario "${name}"${notLoaded(loaded.errors)}` };
  const checks = await check(state, scenario, await state.ledger.read(id));
  return {
    checks: checks.map((c, i) => {
      const e = scenario.expect[i]!;
      // Met once: a call made, or a decision recorded, stays made. Every one is, once the run has ended (`runDetail`).
      return { ...c, settled: c.ok && (("called" in e && e.called === true) || "decision" in e) };
    }),
  };
}
