import { DBOS } from "@dbos-inc/dbos-sdk";
import { indexDrivers } from "./config.ts";
import type { Use } from "./define.ts";
import { SanomaError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import { type DriverFn, isOp } from "./op.ts";
import type { Run } from "./run.ts";
import { loadScenarios } from "./scenario.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/**
 * Seeds a sandbox run of the scenario `name`, from the worker, in one step: reads the scenario,
 * checks that it runs this workflow and that every operation the workflow uses or the scenario
 * seeds has a fake, makes its own copies of the worker's fakes (`Fake.fresh`), calls each
 * `Given` operation through them, injects the faults into them, then puts their functions on the
 * run. The run then calls those copies only, so sandbox runs never share state. The step's
 * checkpoint never stands in for the copies: a run whose seeding is replayed from it has none,
 * and fails, since a sandbox run does not survive a worker restart.
 */
export async function seedSandbox(run: Run, name: string): Promise<void> {
  const { state } = run;
  let copies: Map<string, DriverFn> | undefined;
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
      const fakes = new Map([...state.fakes].map(([vendor, f]) => [vendor, f.fresh()]));
      const drivers = indexDrivers(
        [...fakes.values()].map((f) => f.driver),
        state.ops,
      );
      const seeded: { op: string; input: unknown; output: unknown }[] = [];
      for (const [i, given] of scenario.given.entries()) {
        if (!("input" in given)) continue;
        const call = { idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId: given.op, attempt: 1 };
        const output = await drivers.get(given.op)!(given.input, call);
        seeded.push({ op: given.op, input: given.input, output });
      }
      for (const given of scenario.given) {
        if ("fault" in given) fakes.get(state.ops.get(given.op)!.vendor)![given.fault](given.op);
      }
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
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}
