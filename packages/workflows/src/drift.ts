import { z } from "zod";
import { isRunControlError } from "./call.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import type { Op } from "./op.ts";
import { type DriftField, diffDeclared, type Resource } from "./resource.ts";
import type { DeclaredResource, ResourceProblem } from "./resources.ts";
import { errorMessage } from "./shared.ts";

export type { DriftField } from "./resource.ts";

// The built-in `drift` workflow: for each resource the data files declare, what the vendor holds
// now against what is declared. It is a workflow like any other, held to the same lint, so every
// vendor call goes through `ctx`: the policy sees each (effect `read`) and the ledger records it.

/** The built-in drift workflow's name, which a config's own workflows may not take. */
export const DRIFT_WORKFLOW = "drift";

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

/** The drift workflow's output. */
export interface DriftReport {
  /** Epoch milliseconds, by `ctx.now()`. */
  startedAt: number;
  /** Epoch milliseconds, by `ctx.now()`. */
  finishedAt: number;
  /** What was wrong in the data files when the run read them: their resources are not in `resources`. */
  problems: ResourceProblem[];
  /** Each resource the data files declared when the run read them, in their order. */
  resources: DriftResult[];
}

/**
 * The drift workflow's input: nothing. The run reads the data files itself, so a run says what
 * they declared when it ran, and no caller can hand it other resources to check.
 */
export const DriftInput = z.object({}).strict();

/**
 * What a drift run records of the data files, as its first step: each resource without its
 * write-only values, and the problems.
 */
export interface DriftDeclared {
  resources: Pick<DeclaredResource, "id" | "vendor" | "type" | "name" | "desired" | "refs">[];
  problems: ResourceProblem[];
}

type State = Record<string, unknown>;

// A resource type's import, as `ctx` gives it: by vendor and type, both only known per run.
type ImportOp = Op<string, string, "import", { id: string }, { id: string; gone: boolean; state?: State }>;

/** What one import found: the object's state, that it is gone, or why it could not be read. */
type Found = { state: State } | { gone: true } | { error: string };

/**
 * The drift workflow for a config: it `uses` the `import` of every resource type the connectors
 * declare (`types`) that has a driver, so its version changes with them, not with the data
 * files. `resolveConfig` adds it to a config whose connectors declare resource types, with
 * `declared`, the step that reads the data files.
 *
 * A run reads the data files (`declared`, recorded as a step, so a replay checks the same list),
 * then imports each resource by its import id (its `name`), in the files' order: one vendor call
 * each. An import that says gone is `gone`. Else the state and the declared fields are compared
 * by `diffDeclared`, a reference against the state of the resource it names, read in the same run
 * (so GitHub's node id for a repository counts as its name). A failed call is that resource's
 * `error`, and the run goes on to the next; a failure that ends the run (`isRunControlError`)
 * ends it.
 */
export function driftWorkflow(
  types: ReadonlyMap<string, Resource>,
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
  declared: () => Promise<DriftDeclared>,
): WorkflowDefinition<readonly ImportOp[], typeof DriftInput> {
  const uses = [...types.keys()].toSorted().flatMap((type) => {
    const op = ops.get(`${type}.import`);
    return op && drivers.has(op.id) ? [op as ImportOp] : [];
  });
  // Why a resource of each type cannot be read, if it cannot.
  const unreadable = new Map<string, string>();
  for (const type of types.keys()) {
    if (!uses.some((op) => op.id === `${type}.import`)) unreadable.set(type, `no driver for ${type}.import`);
  }
  return defineWorkflow({
    name: DRIFT_WORKFLOW,
    title: "Check resources for drift",
    trigger: "manual",
    input: DriftInput,
    uses,
    run: async (ctx) => {
      const startedAt = await ctx.now();
      const { resources, problems } = await declared();
      // Every import first, so a reference compares against what its resource holds now.
      const found = new Map<string, Found>();
      for (const { id, vendor, type, name } of resources) {
        const key = `${vendor}.${type}`;
        const why = types.has(key) ? unreadable.get(key) : `the config's connectors declare no resource type ${key}`;
        // An if/else, not a `continue`: the outline draws the import as the way past the error.
        if (why !== undefined) found.set(id, { error: why });
        else {
          try {
            const out = await ctx[vendor]![type]!.import({ id: name });
            found.set(id, out.gone || !out.state ? { gone: true } : { state: out.state });
          } catch (err) {
            if (isRunControlError(err)) throw err;
            found.set(id, { error: errorMessage(err) });
          }
        }
      }
      const results = resources.map(({ id, vendor, type, name, desired, refs }): DriftResult => {
        const row = { id, type, vendor, name };
        const now = found.get(id)!;
        if ("error" in now) return { ...row, status: "error", fields: [], error: now.error };
        if ("gone" in now) return { ...row, status: "gone", fields: [] };
        const resource = types.get(`${vendor}.${type}`)!;
        // Each reference, by where it is: the values the vendor may hold there for its resource.
        const accept: Record<string, unknown[]> = {};
        for (const [at, target] of Object.entries(refs)) {
          const by = resource.fields.references?.[at.replaceAll(/\.\d+(?=\.|$)/g, "")]?.by ?? [];
          const named = found.get(target);
          if (named && "state" in named) accept[at] = by.map((field) => named.state[field]).filter((v) => v != null);
        }
        const fields = diffDeclared(resource, now.state, desired, accept);
        return { ...row, status: fields.length ? "drifted" : "clean", fields };
      });
      return { startedAt, finishedAt: await ctx.now(), problems, resources: results } satisfies DriftReport;
    },
  });
}
