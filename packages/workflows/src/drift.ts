import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { errorCode } from "./errors.ts";
import type { Op } from "./op.ts";
import type { Resource } from "./resource.ts";
import { errorMessage } from "./shared.ts";

// The built-in `drift` workflow: for each resource the data files declare, what the vendor holds
// now against what is declared. It is a workflow like any other, held to the same lint, so every
// vendor call goes through `ctx`: the policy sees each (effect `read`) and the ledger records it.

/** The built-in drift workflow's name, which a config's own workflows may not take. */
export const DRIFT_WORKFLOW = "drift";

/** A declared field the vendor holds another value in. */
export interface DriftField {
  /** Its dotted path, a list item's with its index: `required_pull_request_reviews.0.dismiss_stale_reviews`. */
  path: string;
  /** What the data file declares. */
  desired: unknown;
  /** What the vendor holds, `null` for nothing. */
  actual: unknown;
}

/**
 * How a declared resource compares: `clean` when every declared field holds its declared value,
 * `drifted` when one does not, `gone` when the vendor has no such object, and `error` when it
 * could not be read (the vendor's error, a policy denial, or no driver for its type).
 */
export type DriftStatus = "clean" | "drifted" | "gone" | "error";

/** One declared resource in a drift report. */
export interface DriftResult {
  /** The resource's id, `<file>#<export>`: `resources/identity/github.ts#website`. */
  id: string;
  /** Its type within the vendor, such as `repository`. */
  type: string;
  vendor: string;
  /** Its import id. */
  name: string;
  status: DriftStatus;
  /** The declared fields that differ; empty unless `drifted`. */
  fields: DriftField[];
  /** Why it could not be read, for `error`. */
  error?: string;
}

/** The drift workflow's output: when it ran, by `ctx.now()`, and each resource in the order given. */
export interface DriftReport {
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds. */
  finishedAt: number;
  resources: DriftResult[];
}

/**
 * The drift workflow's input: the declared resources, as `readDataFiles` reads them, so the run's
 * record (`run.started`) says what it compared against. `SanomaClient.drift` reads them.
 */
export const DriftInput = z.object({
  resources: z.array(
    z.object({
      id: z.string().min(1),
      vendor: z.string().min(1),
      type: z.string().min(1),
      name: z.string().min(1),
      desired: z.record(z.string(), z.unknown()),
    }),
  ),
});

type State = Record<string, unknown>;

// A resource type's operations, as `ctx` gives them: by vendor and type, both only known per run.
type ImportOp = Op<string, string, "import", { id: string }, { id: string; state: State; handle?: string }>;
type ReadOp = Op<
  string,
  string,
  "read",
  { id: string; state?: State; handle?: string },
  { id: string; gone: boolean; state?: State; handle?: string }
>;

/** The built-in workflows, which `describeConfig` marks: made here, never by a config. */
const builtins = new WeakSet<WorkflowDefinition<any, any>>();

/** True for a workflow the runtime adds to a config itself, such as `drift`. */
export const isBuiltin = (wf: WorkflowDefinition<any, any>): boolean => builtins.has(wf);

/**
 * The drift workflow for a config: it `uses` the `import` and `read` of every resource type the
 * connectors declare (`types`) that has a driver, so its version changes with them, not with
 * the data files. `resolveConfig` adds it to a config whose connectors declare resource types.
 *
 * Each resource is imported by its import id (its `name`) and then read with what the import
 * returned, on every run: a run keeps no state for the next yet. A `read` that says gone, or an
 * import the driver answers `not_found`, is `gone`. Else the read's state and the declared fields
 * go through the type's `normalize` (by default `compareDeclared`: declared fields only, never
 * vendor-owned or write-only ones, `unordered` lists as sets), and every leaf that differs is a
 * field of the report. A failed call is that resource's `error`, and the run goes on to the next.
 */
export function driftWorkflow(
  types: ReadonlyMap<string, Resource>,
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
): WorkflowDefinition<readonly (ImportOp | ReadOp)[], typeof DriftInput> {
  const uses = [...types.keys()]
    .toSorted()
    .flatMap((type) => [`${type}.import`, `${type}.read`])
    .flatMap((id) => {
      const op = ops.get(id);
      return op && drivers.has(id) ? [op as ImportOp | ReadOp] : [];
    });
  const usable = new Set<string>(uses.map((op) => op.id));
  const drift = defineWorkflow({
    name: "drift",
    title: "Check resources for drift",
    trigger: "manual",
    input: DriftInput,
    uses,
    run: async (ctx, { resources }) => {
      const startedAt = await ctx.now();
      const results: DriftResult[] = [];
      for (const { id, vendor, type, name, desired } of resources) {
        const result = { id, type, vendor, name };
        const spec = types.get(`${vendor}.${type}`);
        const missing = [`${vendor}.${type}.import`, `${vendor}.${type}.read`].filter((op) => !usable.has(op));
        if (!spec || missing.length) {
          const error = spec
            ? `no driver for ${missing.join(" and ")}`
            : `the config's connectors declare no resource type ${vendor}.${type}`;
          results.push({ ...result, status: "error", fields: [], error });
          continue;
        }
        try {
          const found = await ctx[vendor]![type]!.import({ id: name });
          const now = await ctx[vendor]![type]!.read({ id: name, state: found.state, handle: found.handle });
          if (now.gone || !now.state) {
            results.push({ ...result, status: "gone", fields: [] });
            continue;
          }
          const unordered = new Set(spec.fields.unordered);
          const fields = changes(spec.normalize(desired, desired), spec.normalize(now.state, desired), unordered);
          results.push({ ...result, status: fields.length ? "drifted" : "clean", fields });
        } catch (err) {
          if (!isTheResources(err)) throw err;
          results.push(
            isNotFound(err)
              ? { ...result, status: "gone", fields: [] }
              : { ...result, status: "error", fields: [], error: errorMessage(err) },
          );
        }
      }
      return { startedAt, finishedAt: await ctx.now(), resources: results } satisfies DriftReport;
    },
  });
  builtins.add(drift);
  return drift;
}

/**
 * True for a failure that is one resource's to report: anything but the run ending (a call
 * queued after the run could not record a call) or DBOS cancelling or stopping it, which end the
 * run instead. Read by code and name, never `instanceof`: on a replay DBOS rethrows a copy.
 */
const isTheResources = (err: unknown) => {
  const name = (err as { name?: unknown } | null)?.name;
  return errorCode(err) !== "run_ended" && !(typeof name === "string" && name.startsWith("DBOS"));
};

/** True when the driver says the vendor has no object by that id. */
const isNotFound = (err: unknown) =>
  errorCode(err) === "driver_failed" && (err as { vendorCode?: unknown }).vendorCode === "not_found";

const isObject = (v: unknown): v is State => typeof v === "object" && v !== null && !Array.isArray(v);

const join = (path: string, name: string) => (path ? `${path}.${name}` : name);

/** True when the two are the same JSON, where a missing value is `null`. */
function same(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (isObject(a) && isObject(b)) return Object.keys({ ...a, ...b }).every((key) => same(a[key], b[key]));
  return false;
}

/**
 * Where `actual` differs from `desired`, leaf by leaf: objects field by field, lists of one
 * length item by item, and anything else (a list whose length changed, an `unordered` one, which
 * has no item positions) whole. `path` names the field as `fields` does, without indexes; `at`
 * as the report does, with them.
 */
function changes(desired: unknown, actual: unknown, unordered: ReadonlySet<string>, path = "", at = ""): DriftField[] {
  if (isObject(desired) && isObject(actual)) {
    return Object.keys({ ...desired, ...actual }).flatMap((key) =>
      changes(desired[key], actual[key], unordered, join(path, key), join(at, key)),
    );
  }
  if (Array.isArray(desired) && Array.isArray(actual) && desired.length === actual.length && !unordered.has(path)) {
    return desired.flatMap((item, i) => changes(item, actual[i], unordered, path, join(at, String(i))));
  }
  return same(desired, actual) ? [] : [{ path: at, desired: desired ?? null, actual: actual ?? null }];
}
