import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { isRunControlError } from "./errors.ts";
import type { Op } from "./op.ts";
import { type DriftField, diffDeclared, fieldPathOf, type Resource } from "./resource.ts";
import type { DeclaredResource, ResourceProblem } from "./resources.ts";
import { type DRIFT_WORKFLOW, errorMessage } from "./shared.ts";

export type { DriftField } from "./resource.ts";
export { DRIFT_WORKFLOW } from "./shared.ts";

// The built-in `drift` workflow: for each resource the data files declare, what the vendor holds
// now against what is declared. It is a workflow like any other, held to the same lint, so every
// vendor call goes through `ctx`: the policy sees each (effect `read`) and the ledger records it.

/**
 * How a declared resource compares: `clean` when every declared field of its bound object holds
 * its declared value, `drifted` when one does not, `gone` when the vendor no longer has its bound
 * object, `absent` when it is bound to none (whether or not its identity finds one: `found`), and
 * `error` when it could not be read (the vendor's error, a policy denial, or no driver for its type).
 */
export type DriftStatus = "clean" | "drifted" | "gone" | "absent" | "error";

/** One declared resource in a drift report. */
export interface DriftResult {
  /** The resource's id, `<file>#<export>`: `resources/identity/github.ts#website`. */
  id: string;
  /** Its type within the vendor, such as `repository`. */
  type: string;
  vendor: string;
  /** What people call it: its identity, else its export's name. */
  name: string;
  status: DriftStatus;
  /** The vendor's id of the object the lockfile binds it to; absent when unbound. */
  binding?: string;
  /** For `absent`: the binding id of the object its identity found, which apply may bind it to. */
  found?: string;
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
  resources: Pick<DeclaredResource, "id" | "vendor" | "type" | "name" | "identity" | "binding" | "desired" | "refs">[];
  problems: ResourceProblem[];
}

type State = Record<string, unknown>;

// A resource type's import, as `ctx` gives it: by vendor and type, both only known per run.
type ImportOp = Op<string, string, "import", { id: string }, { id: string; gone: boolean; state?: State }>;
// The built-in `sanoma.source.resolve`, which a host's check calls for the commit its ref names now.
type ResolveOp = Op<"sanoma", "source", "resolve", { url: string; ref: string }, { revision: string }>;

/** A clone URL's schemes: what a `by` field of a host's source holds, told from an id. */
const CLONE_URL = /^(https?|ssh|git|file):\/\//;

/** What one import found: the object's state, that it is gone, or why it could not be read. */
export type Found = { state: State } | { gone: true } | { error: string };
/** What a host's ref names now, or why it could not be resolved. */
type Revision = { revision: string } | { error: string };

// What drift and apply share. Observing a resource is one `ctx` call, which a workflow makes in
// its own `run` (the outline draws only those): `observeBy` says what each import is called with,
// `observed` reads its answer, and `compare` turns what every import found into drift's results.

/** The `import` ops of the types among `ops` with a driver, by type, sorted: what observing them uses. */
export function importsOf(
  types: ReadonlyMap<string, Resource>,
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
): ImportOp[] {
  return [...types.keys()].toSorted().flatMap((type) => {
    const op = ops.get(`${type}.import`);
    return op && drivers.has(op.id) ? [op as ImportOp] : [];
  });
}

/**
 * What a declared resource is observed by: the import id (`by`, default its binding, else its
 * identity), or without one what it is found to be: `gone` for none, `error` when its type is
 * not the connectors' or has no import among `imports`.
 */
export function observeBy(
  { vendor, type, binding, identity }: Pick<DeclaredResource, "vendor" | "type" | "binding" | "identity">,
  types: ReadonlyMap<string, Resource>,
  imports: readonly Pick<Op, "id">[],
  by = binding ?? identity,
): { id: string } | Found {
  const key = `${vendor}.${type}`;
  if (!types.has(key)) return { error: `the config's connectors declare no resource type ${key}` };
  if (!imports.some((op) => op.id === `${key}.import`)) return { error: `no driver for ${key}.import` };
  return by === undefined ? { gone: true } : { id: by };
}

/** What an import's answer found. */
export const observed = (out: { gone: boolean; state?: State }): Found =>
  out.gone || !out.state ? { gone: true } : { state: out.state };

/**
 * Each declared resource against what its import `found`: `error`, `absent` (unbound, with the
 * binding id of what its identity found as `found`), `gone`, else the state and the declared
 * fields compared by `diffDeclared`, a reference against the state of the resource it names
 * (so GitHub's node id for a repository counts as its name). A host with a `revisions` entry
 * also compares its revision against the commit its ref names now (or is that entry's `error`).
 */
export function compare(
  types: ReadonlyMap<string, Resource>,
  resources: DriftDeclared["resources"],
  found: ReadonlyMap<string, Found>,
  revisions: ReadonlyMap<string, Revision> = new Map(),
): DriftResult[] {
  return resources.map(({ id, vendor, type, name, binding, desired, refs }): DriftResult => {
    const row = { id, type, vendor, name, ...(binding !== undefined && { binding }) };
    const now = found.get(id)!;
    if ("error" in now) return { ...row, status: "error", fields: [], error: now.error };
    const resource = types.get(`${vendor}.${type}`)!;
    if (binding === undefined) {
      return {
        ...row,
        status: "absent",
        fields: [],
        ...("state" in now && { found: resource.bindingId(now.state) }),
      };
    }
    if ("gone" in now) return { ...row, status: "gone", fields: [] };
    // Each reference, by where it is: the values the vendor may hold there for its resource.
    const accept: Record<string, unknown[]> = {};
    for (const [at, target] of Object.entries(refs)) {
      const by = resource.fields.references?.[fieldPathOf(at)]?.by ?? [];
      const named = found.get(target);
      if (named && "state" in named) accept[at] = by.map((field) => named.state[field]).filter((v) => v != null);
    }
    const fields = diffDeclared(resource, now.state, desired, accept);
    const resolved = revisions.get(id);
    if (resolved && "error" in resolved) return { ...row, status: "error", fields: [], error: resolved.error };
    const actual = resource.host?.outputs(now.state).revision;
    if (resolved && actual !== resolved.revision) {
      fields.push({ path: resource.host!.revision, desired: resolved.revision, actual: actual ?? null });
    }
    return { ...row, status: fields.length ? "drifted" : "clean", fields };
  });
}

/**
 * The drift workflow for a config: it `uses` the `import` of every resource type the connectors
 * declare (`types`) that has a driver, so its version changes with them, not with the data
 * files. `resolveConfig` adds it to a config whose connectors declare resource types, with
 * `declared`, the step that reads the data files.
 *
 * A run reads the data files and the lockfile (`declared`, recorded as a step, so a replay checks
 * the same list), then imports each resource by its binding, else by its identity, in the files'
 * order: one vendor call each, none for a resource with neither. A bound resource whose import
 * says gone is `gone`; an unbound one is `absent`, with the binding id of what its identity found
 * as `found`. Else the state and the declared fields are compared by `diffDeclared`, a reference
 * against the state of the resource it names, read in the same run (so GitHub's node id for a
 * repository counts as its name). A failed call is that resource's
 * `error`, and the run goes on to the next; a failure that ends the run (`isRunControlError`)
 * ends it.
 */
export function driftWorkflow(
  types: ReadonlyMap<string, Resource>,
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
  declared: () => Promise<DriftDeclared>,
): WorkflowDefinition<readonly (ImportOp | ResolveOp)[], typeof DriftInput> {
  const imports = importsOf(types, ops, drivers);
  const resolve = ops.get("sanoma.source.resolve" satisfies ResolveOp["id"]) as ResolveOp | undefined;
  const uses = [...imports, ...(resolve ? [resolve] : [])];
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "drift" satisfies typeof DRIFT_WORKFLOW,
    title: "Check resources for drift",
    trigger: "manual",
    input: DriftInput,
    uses,
    run: async (ctx) => {
      const startedAt = await ctx.now();
      const { resources, problems } = await declared();
      // Every import first, so a reference compares against what its resource holds now.
      const found = new Map<string, Found>();
      for (const resource of resources) {
        const by = observeBy(resource, types, imports);
        // An if/else, not a `continue`: the outline draws the import as the way past the error.
        if (!("id" in by)) found.set(resource.id, by);
        else {
          try {
            found.set(resource.id, observed(await ctx[resource.vendor]![resource.type]!.import({ id: by.id })));
          } catch (err) {
            if (isRunControlError(err)) throw err;
            found.set(resource.id, { error: errorMessage(err) });
          }
        }
      }
      // A host's revision against the commit its ref names now: a merge is drift on the host.
      const revisions = new Map<string, Revision>();
      for (const { id, vendor, type, desired, refs } of resources) {
        const resource = types.get(`${vendor}.${type}`);
        const host = resource?.host;
        const source = host && sourceUrl(desired, refs[host.inputs.source], resource, found);
        if (host && "state" in found.get(id)! && source !== undefined) {
          try {
            const ref = String(valueAt(desired, host.inputs.ref));
            revisions.set(id, await ctx.sanoma!.source!.resolve({ url: source, ref }));
          } catch (err) {
            if (isRunControlError(err)) throw err;
            revisions.set(id, { error: errorMessage(err) });
          }
        }
      }
      const results = compare(types, resources, found, revisions);
      return { startedAt, finishedAt: await ctx.now(), problems, resources: results } satisfies DriftReport;
    },
  });
}

/** The value at a dotted path, a list item's by its index. */
const valueAt = (value: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as State)[key] : undefined), value);

/**
 * A host's source: the clone URL its data file gives, or, when it names a declared repository
 * (`target`), the first of the reference's `by` fields that holds one in that repository's state,
 * read in this run.
 */
function sourceUrl(
  desired: State,
  target: string | undefined,
  { host, fields }: Resource,
  found: ReadonlyMap<string, Found>,
): string | undefined {
  const path = host!.inputs.source;
  const named = target === undefined ? undefined : found.get(target);
  const by = fields.references?.[path]?.by ?? [];
  const values =
    target === undefined ? [valueAt(desired, path)] : named && "state" in named ? by.map((f) => named.state[f]) : [];
  return values.find((v): v is string => typeof v === "string" && CLONE_URL.test(v));
}
