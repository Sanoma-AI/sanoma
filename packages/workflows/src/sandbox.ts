import { DBOS } from "@dbos-inc/dbos-sdk";
import { indexDrivers, sandboxDrivers } from "./config.ts";
import { CALL_WORKFLOW, CallInput } from "./call-workflow.ts";
import { opIdsOf } from "./define.ts";
import { SanomaError } from "./errors.ts";
import type { Fake, ResourceFake } from "./fake.ts";
import { entry, type LedgerRecord, write } from "./ledger.ts";
import type { DriverFn } from "./op.ts";
import type { Run } from "./run.ts";
import { memorySecrets } from "./secret.ts";
import { type Given, loadScenarios, type Scenario } from "./scenario.ts";
import { errorMessage } from "./shared.ts";

/*
 * What a worker does for a sandbox run, imported only when it starts one: kept apart from
 * `scenario.ts`, which the app reads too, because it needs DBOS and the ledger.
 */

/** True for a fake that holds resources (`ResourceFake`, as `@sanoma-ai/bridge`'s `tfFake` is). */
const holdsResources = (fake: Fake<unknown>): fake is Fake<unknown> & ResourceFake =>
  "override" in fake && "put" in fake && "remove" in fake;

/**
 * The error a sandbox run of the scenario fails with when it seeds a resource of a vendor whose
 * fake (one of `fakes`, by vendor) holds none, or whose connector attaches no fake; undefined
 * when every vendor it seeds a resource of has a `ResourceFake`. Pure.
 */
export function missingResourceFake(
  scenario: Pick<Scenario, "name" | "given">,
  fakes: ReadonlyMap<string, Fake<unknown>>,
): SanomaError | undefined {
  const plain = scenario.given.filter((g): g is Extract<Given, { resource: string }> => {
    if (!("resource" in g)) return false;
    const fake = fakes.get(g.vendor);
    return !fake || !holdsResources(fake);
  });
  if (plain.length === 0) return undefined;
  const resources = [...new Set(plain.map((g) => g.resource))];
  const vendors = [...new Set(plain.map((g) => g.vendor))];
  const why = vendors.map((v) =>
    fakes.has(v) ? `${v}'s fake holds no resources (it is not a tfFake)` : `${v}'s connector attaches no fake`,
  );
  return new SanomaError(
    "invalid_input",
    `Scenario "${scenario.name}" seeds ${resources.join(", ")}, but ${why.join("; ")}`,
    {
      scenario: scenario.name,
      resources,
    },
  );
}

/**
 * Seeds one resource into the run's own fake of its vendor: put with its fields, or removed.
 * A seed the fake refuses (a field the provider's shape lacks, say) fails the scenario, naming
 * the step, as the other seed-time refusals do.
 */
export function seedResource(
  scenario: string,
  copy: ResourceFake,
  given: Extract<Given, { resource: string }>,
): Extract<LedgerRecord, { type: "scenario.seeded" }>["seeds"][number] {
  const { resource, type, name } = given;
  try {
    if ("gone" in given) {
      copy.remove(type, name);
      return { resource, name, gone: true };
    }
    copy.put(type, name, given.fields);
    return { resource, name, fields: given.fields };
  } catch (err) {
    throw new SanomaError(
      "invalid_input",
      `Scenario "${scenario}" cannot seed ${resource} "${name}" ("${given.step}"): ${errorMessage(err)}`,
      { scenario, step: given.step, resource, name },
      { cause: err },
    );
  }
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
        const why = errors.length ? `; these files did not load: ${errors.map((e) => e.message).join("; ")}` : "";
        throw new SanomaError("invalid_input", `No scenario named "${name}"${why}`, { scenario: name });
      }
      if (scenario.workflow !== run.workflow) {
        throw new SanomaError("invalid_input", `Scenario "${name}" runs ${scenario.workflow}, not ${run.workflow}`, {
          scenario: name,
          workflow: scenario.workflow,
        });
      }
      const fakes = new Map([...state.fakes].map(([vendor, make]) => [vendor, make()]));
      // The built-ins first, so a connector's fake that implements one of their operations wins.
      const drivers = indexDrivers(
        [...sandboxDrivers(state.ops), ...Array.from(fakes.values(), (f) => f.driver)],
        state.ops,
      );
      // The built-in call workflow selects exactly one operation. Other direct operations
      // (including live connection mutations) need no fake unless this scenario calls them.
      const uses =
        run.workflow === CALL_WORKFLOW ? [CallInput.parse(input).op] : opIdsOf(state.workflows.get(run.workflow)!);
      const seeding = scenario.given.flatMap((g) => ("op" in g ? [g.op] : []));
      const missing = [...new Set([...uses, ...seeding])].filter((id) => !drivers.has(id));
      if (missing.length) {
        throw new SanomaError(
          "invalid_input",
          `A sandbox run of ${run.workflow} has no fake for ${missing.join(", ")}: no fake its connectors attach implements ${missing.length > 1 ? "them" : "it"}`,
          { scenario: name, missing },
        );
      }
      const plain = missingResourceFake(scenario, fakes);
      if (plain) throw plain;
      const seeded: Extract<LedgerRecord, { type: "scenario.seeded" }>["seeds"] = [];
      for (const [i, given] of scenario.given.entries()) {
        if ("fault" in given) continue;
        if ("op" in given) {
          const call = { idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId: given.op, attempt: 1, secrets };
          const output = await drivers.get(given.op)!(given.input, call);
          seeded.push({ op: given.op, input: given.input, output });
          continue;
        }
        // Checked above: the vendor's fake holds resources.
        seeded.push(seedResource(name, fakes.get(given.vendor) as Fake<unknown> & ResourceFake, given));
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
  run.fakeSecrets = secrets;
  await write(run, entry(run, { type: "scenario.seeded", scenario: name, seeds }));
}
