import { DBOS } from "@dbos-inc/dbos-sdk";
import { SanomaError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import type { Run } from "./run.ts";
import { loadScenarios } from "./scenario.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/**
 * Seeds the fakes for a sandbox run of the scenario `name`, from the worker: once, in a step,
 * so a replay never seeds twice. Refuses while another sandbox run holds the worker's fakes.
 * Resets every fake, calls each `Given` operation through its fake, then injects the faults,
 * and empties the call log, so it holds the run's calls only.
 */
export async function seedSandbox(run: Run, name: string): Promise<void> {
  const { state } = run;
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
  const { seeds } = await DBOS.runStep(
    async () => {
      if (state.sandboxRun !== undefined && state.sandboxRun !== run.id) {
        throw new SanomaError(
          "sandbox_busy",
          `Sandbox run ${state.sandboxRun} is still using the fakes; start another once it ends`,
          { runId: state.sandboxRun },
        );
      }
      state.sandboxRun = run.id;
      const missing = scenario.given.filter((g) => !state.fakeDrivers.has(g.op)).map((g) => g.op);
      if (missing.length) {
        throw new SanomaError(
          "invalid_input",
          `No fake for ${[...new Set(missing)].join(", ")}: add its vendor's fake to the config's \`fakes\``,
        );
      }
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
      return { seeds: seeded };
    },
    { name: "sandbox:seed" },
  );
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}
