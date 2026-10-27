import { DBOS } from "@dbos-inc/dbos-sdk";
import { indexDrivers } from "./config.ts";
import { opIdsOf } from "./define.ts";
import { SanomaError } from "./errors.ts";
import type { Fake, ResourceFake } from "./fake.ts";
import { entry, type LedgerRecord, write } from "./ledger.ts";
import type { CallContext, DriverFn, Op } from "./op.ts";
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
): Seeds[number] {
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

/** What a scenario's `Given` steps seeded, as its `scenario.seeded` record has it. */
export type Seeds = Extract<LedgerRecord, { type: "scenario.seeded" }>["seeds"];

/**
 * Where a scenario's `Given` steps go (`applyGivens`): a sandbox run's own fakes (`run`), or the
 * instance a demo runs (`instance`), its collections in the config's database and every vendor
 * on its one fake, which every run shares, so a fault, injected into a call some other run would
 * make, is refused there.
 */
export interface GivenTarget {
  kind: "run" | "instance";
  /** What a `Given` operation is called through, by operation id. */
  drivers: ReadonlyMap<string, DriverFn>;
  /** The fakes, by vendor id: what a `Given` resource is put in, and a `run`'s faults injected into. */
  fakes: ReadonlyMap<string, Fake<unknown>>;
  /** The operations by id, for a fault's vendor. */
  ops: ReadonlyMap<string, Op>;
  /** The context of the call the `i`th `Given` makes. */
  call(i: number, op: string): CallContext;
}

/**
 * Applies the scenario's `Given` steps to the target: calls each operation through its drivers,
 * puts or removes each resource in its vendor's fake, then, for a `run`, injects the faults.
 * Checks first that every operation it seeds has a driver there, that every resource's vendor has
 * a fake holding resources, and, for an `instance`, that it injects no fault. Returns what it
 * seeded, in order.
 */
export async function applyGivens(scenario: Pick<Scenario, "name" | "given">, target: GivenTarget): Promise<Seeds> {
  const { name, given } = scenario;
  const fault = given.find((g) => "fault" in g);
  if (fault && target.kind === "instance") {
    throw new SanomaError(
      "invalid_input",
      `Scenario "${name}" injects a fault ("${fault.step}"), but its Givens go to the instance, whose fakes every run shares`,
      { scenario: name, step: fault.step },
    );
  }
  const missing = [...new Set(given.flatMap((g) => ("op" in g && !target.drivers.has(g.op) ? [g.op] : [])))];
  if (missing.length) {
    throw new SanomaError(
      "invalid_input",
      `Scenario "${name}" seeds ${missing.join(", ")}, but no fake its connectors attach implements ${missing.length > 1 ? "them" : "it"}`,
      { scenario: name, missing },
    );
  }
  const plain = missingResourceFake(scenario, target.fakes);
  if (plain) throw plain;
  const seeded: Seeds = [];
  for (const [i, g] of given.entries()) {
    if ("fault" in g) continue;
    if ("op" in g) {
      const output = await target.drivers.get(g.op)!(g.input, target.call(i, g.op));
      seeded.push({ op: g.op, input: g.input, output });
      continue;
    }
    // Checked above: the vendor's fake holds resources.
    seeded.push(seedResource(name, target.fakes.get(g.vendor) as Fake<unknown> & ResourceFake, g));
  }
  for (const g of given) {
    if ("fault" in g) target.fakes.get(target.ops.get(g.op)!.vendor)![g.fault](g.op);
  }
  return seeded;
}

/**
 * Seeds a sandbox run of the scenario `name`, from the worker, in one step: reads the scenario,
 * checks that it runs this workflow, picks the run's fakes, checks that every operation the
 * workflow uses has one, then applies the scenario's `Given` steps to them
 * (`applyGivens`) and puts their functions on the run. The run then calls those only. Its fakes
 * are its own (each vendor's maker, called once for the run), so sandbox runs share no state when
 * the makers make a new fake each; on an instance that runs on fakes (`instanceFakes`) they are
 * the instance's, which its sandbox runs share, as its live drivers are. The step's checkpoint
 * never stands in for a run's own: a run whose seeding is replayed from it has none, and fails,
 * since a sandbox run does not survive a worker restart; on an instance's fakes it goes on with them.
 */
export async function seedSandbox(run: Run, name: string): Promise<void> {
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
        const runs = scenario.workflow === undefined ? "is a world, which runs nothing" : `runs ${scenario.workflow}`;
        throw new SanomaError("invalid_input", `Scenario "${name}" ${runs}, not ${run.workflow}`, {
          scenario: name,
          ...(scenario.workflow !== undefined && { workflow: scenario.workflow }),
        });
      }
      const instance = state.instanceFakes;
      const fakes = instance ?? new Map([...state.fakes].map(([vendor, make]) => [vendor, make()]));
      // The fakes' drivers, and the built-in ones that read only the repository (`sanoma.apps.list`).
      const drivers = instance
        ? state.drivers
        : indexDrivers([...[...fakes.values()].map((f) => f.driver), ...state.repoDrivers], state.ops);
      // What the scenario seeds is checked by `applyGivens`.
      const missing = opIdsOf(state.workflows.get(run.workflow)!).filter((id) => !drivers.has(id));
      if (missing.length) {
        throw new SanomaError(
          "invalid_input",
          `A sandbox run of ${run.workflow} has no fake for ${missing.join(", ")}: no fake its connectors attach implements ${missing.length > 1 ? "them" : "it"}`,
          { scenario: name, missing },
        );
      }
      const seeded = await applyGivens(scenario, {
        kind: instance ? "instance" : "run",
        drivers,
        fakes,
        ops: state.ops,
        call: (i, opId) => ({ idempotencyKey: `${run.id}:seed:${i}`, runId: run.id, opId, attempt: 1, secrets }),
      });
      copies = drivers;
      return { seeds: seeded };
    },
    { name: "sandbox:seed" },
  );
  // Replayed on an instance that runs on fakes: they are the instance's, still there in this process.
  if (!copies && state.instanceFakes) copies = state.drivers;
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
