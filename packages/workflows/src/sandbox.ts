import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Use } from "./define.ts";
import { SanomaError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import { isOp } from "./op.ts";
import type { Run } from "./run.ts";
import { loadScenarios } from "./scenario.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/**
 * The sandbox runs this process seeded the fakes for and has not yet checked. A run's seed step
 * that DBOS replays from its checkpoint (after a worker restart, or in a fork) never ran here,
 * so it is not among them: the fakes are not in the state it left them in.
 */
const seededHere = new Set<string>();

/**
 * Seeds the fakes for a sandbox run of the scenario `name`, from the worker, in one step: reads
 * the scenario, checks that it runs this workflow and that every operation the workflow uses
 * or the scenario seeds has a fake, resets every fake, calls each `Given` operation through its
 * fake, then injects the faults, and empties the call log, so it holds the run's calls only.
 * The step's checkpoint never stands in for the fakes' state: a run whose seeding is replayed
 * from it fails, since a sandbox run does not survive a worker restart.
 */
export async function seedSandbox(run: Run, name: string): Promise<void> {
  const { state } = run;
  const { seeds } = await DBOS.runStep(
    async () => {
      // Read in the step, so a recovered run never reads a feature file edited or renamed since.
      const { scenarios, errors } = loadScenarios(state);
      const scenario = scenarios.find((s) => s.name === name);
      if (!scenario) {
        const why = errors.length ? `; these files did not load: ${errors.map((e) => e.message).join("; ")}` : "";
        throw new SanomaError("invalid_input", `No scenario named "${name}"${why}`, { scenario: name });
      }
      if (scenario.workflow !== run.workflow) {
        throw new SanomaError("invalid_input", `Scenario "${name}" runs ${scenario.workflow}, not ${run.workflow}`, {
          scenario: name,
          workflow: scenario.workflow,
        });
      }
      const uses = (state.workflows.get(run.workflow)!.uses as readonly Use[]).filter(isOp).map((op) => op.id);
      const missing = [...new Set([...uses, ...scenario.given.map((g) => g.op)])].filter(
        (id) => !state.fakeDrivers.has(id),
      );
      if (missing.length) {
        throw new SanomaError(
          "invalid_input",
          `A sandbox run of ${run.workflow} has no fake for ${missing.join(", ")}: add their vendors' fakes to the config's \`fakes\``,
          { scenario: name, missing },
        );
      }
      if (state.sandboxRun !== undefined && state.sandboxRun !== run.id) {
        throw new SanomaError(
          "sandbox_busy",
          `Sandbox run ${state.sandboxRun} is still using the fakes; start another once it ends`,
          { runId: state.sandboxRun },
        );
      }
      state.sandboxRun = run.id;
      for (const f of state.fakes.values()) f.reset();
      const seeded: { op: string; input: unknown; output: unknown }[] = [];
      for (const [i, given] of scenario.given.entries()) {
        if (!("input" in given)) continue;
        const call = { idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId: given.op, attempt: 1 };
        const output = await state.fakeDrivers.get(given.op)!(given.input, call);
        seeded.push({ op: given.op, input: given.input, output });
      }
      for (const given of scenario.given) {
        if ("fault" in given) state.fakes.get(state.ops.get(given.op)!.vendor)![given.fault](given.op);
      }
      for (const f of state.fakes.values()) f.calls.splice(0);
      seededHere.add(run.id);
      return { seeds: seeded };
    },
    { name: "sandbox:seed" },
  );
  if (!seededHere.delete(run.id)) {
    // The records written before the restart hold the seqs from here on: the failure goes after them.
    run.seq = Math.max(run.seq, ...(await state.ledger.read(run.id)).map((r) => r.seq + 1));
    throw new SanomaError(
      "invalid_input",
      `Sandbox run ${run.id} was interrupted by a worker restart and the fakes' state is gone; start the scenario again`,
      { runId: run.id, scenario: name },
    );
  }
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}
