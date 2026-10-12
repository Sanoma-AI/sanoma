import { DBOS } from "@dbos-inc/dbos-sdk";
import { indexDrivers } from "./config.ts";
import { opIdsOf } from "./define.ts";
import { SanomaError } from "./errors.ts";
import type { Fake } from "./fake.ts";
import { entry, write } from "./ledger.ts";
import type { CallContext, DriverFn } from "./op.ts";
import type { Run } from "./run.ts";
import { type Given, loadScenarios } from "./scenario.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/** A fake that holds a vendor's objects, as `@sanoma/bridge`'s `tfFake` does, by resource type and import id. */
interface HoldsResources {
  override(type: string, id: string, fields: Record<string, unknown>): void;
  put(type: string, id: string, fields: Record<string, unknown>): void;
  remove(type: string, id: string): void;
}

/** A resource type's vendor: `github` of `github.repository`. */
const vendorOf = (resource: string) => resource.slice(0, resource.indexOf("."));

const holdsResources = (fake: Fake<unknown>): fake is Fake<unknown> & HoldsResources =>
  ["override", "put", "remove"].every(
    (name) => typeof (fake as Partial<HoldsResources>)[name as keyof HoldsResources] === "function",
  );

/**
 * Seeds one resource into the run's copy of its vendor's fake: `fields` set on the object, put
 * when the vendor has none (the copy's `import` says), or the object removed. `Fake.fresh` gives
 * a plain fake, so the template's `override`, `put` and `remove` do the work; they write through
 * its `update`, which the copy's stands in for while they run (synchronous, so no other call sees it).
 */
async function seedResource(
  template: Fake<unknown> & HoldsResources,
  copy: Fake<unknown>,
  importOp: DriverFn,
  given: Extract<Given, { resource: string }>,
  call: CallContext,
): Promise<void> {
  const type = given.resource.slice(given.resource.indexOf(".") + 1);
  const { gone } = (await importOp({ id: given.name }, call)) as { gone: boolean };
  const { update } = template;
  template.update = copy.update;
  try {
    if ("gone" in given) {
      if (!gone) template.remove(type, given.name);
    } else if (gone) template.put(type, given.name, given.fields);
    else template.override(type, given.name, given.fields);
  } finally {
    template.update = update;
  }
}

/**
 * Seeds a sandbox run of the scenario `name`, from the worker, in one step: reads the scenario,
 * checks that it runs this workflow and that every operation the workflow uses or the scenario
 * seeds has a fake (and every resource it seeds a fake holding resources), makes its own copies
 * of the worker's fakes (`Fake.fresh`), calls each `Given` operation through them, puts or
 * removes each `Given` resource in them, injects the faults into them, then puts their functions
 * on the run. The run then calls those copies only, so sandbox runs never share state. The
 * step's checkpoint never stands in for the copies: a run whose seeding is replayed from it has
 * none, and fails, since a sandbox run does not survive a worker restart.
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
      const uses = opIdsOf(state.workflows.get(run.workflow)!);
      const seeding = scenario.given.flatMap((g) => ("op" in g ? [g.op] : [`${g.resource}.import`]));
      const missing = [...new Set([...uses, ...seeding])].filter((id) => !state.fakeDrivers.has(id));
      if (missing.length) {
        throw new SanomaError(
          "invalid_input",
          `A sandbox run of ${run.workflow} has no fake for ${missing.join(", ")}: add their vendors' fakes to the config's \`fakes\``,
          { scenario: name, missing },
        );
      }
      const plain = scenario.given
        .flatMap((g) => ("resource" in g ? [g.resource] : []))
        .filter((resource) => !holdsResources(state.fakes.get(vendorOf(resource))!));
      if (plain.length) {
        throw new SanomaError(
          "invalid_input",
          `Scenario "${name}" seeds ${[...new Set(plain)].join(", ")}, but ${[...new Set(plain.map(vendorOf))].join(", ")}'s fake holds no resources (it is not a tfFake)`,
          { scenario: name, resources: [...new Set(plain)] },
        );
      }
      const fakes = new Map([...state.fakes].map(([vendor, f]) => [vendor, f.fresh()]));
      const drivers = indexDrivers(
        [...fakes.values()].map((f) => f.driver),
        state.ops,
      );
      const seeded: { op: string; input: unknown; output: unknown }[] = [];
      for (const [i, given] of scenario.given.entries()) {
        if ("fault" in given) continue;
        const opId = "op" in given ? given.op : `${given.resource}.import`;
        const call = { idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId, attempt: 1 };
        if ("op" in given) {
          const output = await drivers.get(given.op)!(given.input, call);
          seeded.push({ op: given.op, input: given.input, output });
        } else {
          const vendor = vendorOf(given.resource);
          const template = state.fakes.get(vendor) as Fake<unknown> & HoldsResources;
          await seedResource(template, fakes.get(vendor)!, drivers.get(opId)!, given, call);
        }
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
