import type { ConnectionRef } from "./connection.ts";
import { SanomaError } from "./errors.ts";
import type { Fake, ResourceFake } from "./fake.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { CallContext, DriverFn, Op } from "./op.ts";
import type { Given, Scenario } from "./scenario.ts";
import { errorMessage } from "./shared.ts";

// A scenario's `Given` steps applied to fakes: a sandbox run's own (`seedSandbox` in
// `sandbox.ts`), and a page's, which every run in the page shares (`page-run.ts`). Browser-safe:
// no DBOS, no Cucumber.

/** What a scenario's `Given` steps seeded, as its `scenario.seeded` record has it. */
export type Seeds = Extract<LedgerRecord, { type: "scenario.seeded" }>["seeds"];

/** Where a scenario's `Given` steps go (`applyGivens`). */
export interface GivenTarget {
  /** What a `Given` operation is called through, by operation id. */
  drivers: ReadonlyMap<string, DriverFn>;
  /** The fakes, by vendor: whether a `Given` resource's vendor has a fake that holds resources. */
  fakes: ReadonlyMap<string, Fake<unknown>>;
  /** The fake a `Given` resource is put in, or a fault injected into: the vendor's, or its account's that `connection` names. */
  fakeOf(vendor: string, connection?: ConnectionRef): Fake<unknown>;
  /** The operations by id, for a fault's vendor. */
  ops: ReadonlyMap<string, Op>;
  /** The context of the call the `i`th `Given` makes, of the operation `op`, on the account `connection` names. */
  call(i: number, op: string, connection?: ConnectionRef): CallContext;
}

/**
 * Refuses the operations among `ids` that no fake's driver in `drivers` implements, as what
 * `subject` says calls them (`Workflow "x" uses`, `Scenario "y" seeds`): `invalid_input` with
 * `data` and the ones `missing`. A sandbox run's, a world's and a page's workflows' one check.
 */
export function refuseUnfaked(
  subject: string,
  ids: Iterable<string>,
  drivers: ReadonlyMap<string, unknown>,
  data: Record<string, unknown>,
): void {
  const missing = [...new Set(ids)].filter((id) => !drivers.has(id));
  if (missing.length === 0) return;
  throw new SanomaError(
    "invalid_input",
    `${subject} ${missing.join(", ")}, but no fake its connectors attach implements ${missing.length > 1 ? "them" : "it"}`,
    { ...data, missing },
  );
}

/** True for a fake that holds resources (`ResourceFake`, as `sanoma/internal/bridge`'s `tfFake` is). */
const holdsResources = (fake: Fake<unknown>): fake is Fake<unknown> & ResourceFake =>
  "override" in fake && "put" in fake && "remove" in fake;

/**
 * The error a run of the scenario fails with when it seeds a resource of a vendor whose fake (one
 * of `fakes`, by vendor) holds none, or whose connector attaches no fake; undefined when every
 * vendor it seeds a resource of has a `ResourceFake`. Pure.
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
 * Seeds one resource into a fake of its vendor: put with its fields, or removed. A seed the fake
 * refuses (a field the provider's shape lacks, say) fails the scenario, naming the step, as the
 * other seed-time refusals do.
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

/**
 * Applies the scenario's `Given` steps to the target: calls each operation through its drivers,
 * puts or removes each resource in its vendor's fake, then injects the faults. Checks first that
 * every operation it seeds has a driver there and that every resource's vendor has a fake holding
 * resources. Returns what it seeded, in order.
 */
export async function applyGivens(scenario: Pick<Scenario, "name" | "given">, target: GivenTarget): Promise<Seeds> {
  const { name, given } = scenario;
  refuseUnfaked(
    `Scenario "${name}" seeds`,
    given.flatMap((g) => ("op" in g ? [g.op] : [])),
    target.drivers,
    {
      scenario: name,
    },
  );
  const plain = missingResourceFake(scenario, target.fakes);
  if (plain) throw plain;
  const seeded: Seeds = [];
  for (const [i, g] of given.entries()) {
    if ("fault" in g) continue;
    if ("op" in g) {
      const output = await target.drivers.get(g.op)!(g.input, target.call(i, g.op, g.connection));
      seeded.push({ op: g.op, input: g.input, output });
      continue;
    }
    // Checked above: the vendor's fake holds resources.
    seeded.push(seedResource(name, target.fakeOf(g.vendor, g.connection) as Fake<unknown> & ResourceFake, g));
  }
  for (const g of given) {
    if ("fault" in g) target.fakeOf(target.ops.get(g.op)!.vendor, g.connection)[g.fault](g.op);
  }
  return seeded;
}
