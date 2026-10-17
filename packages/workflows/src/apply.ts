import { z } from "zod";
import { type Approver, defineWorkflow, type WorkflowDefinition } from "./define.ts";
import {
  compare,
  type DriftDeclared,
  type DriftField,
  type DriftResult,
  type Found,
  importsOf,
  observeBy,
  observed,
  type ResolveOp,
  type Revision,
  sourceUrl,
} from "./drift.ts";
import { isRunControlError } from "./errors.ts";
import type { Binding, Bindings, Rebind } from "./lockfile.ts";
import type { Op } from "./op.ts";
import { fieldPathOf, holderOf, type PlanAction, type Resource, valueAt } from "./resource.ts";
import type { ResourceProblem } from "./resources.ts";
import { type APPLY_WORKFLOW, errorMessage } from "./shared.ts";
import { SOURCE_RESOLVE } from "./source.ts";

export { APPLY_WORKFLOW } from "./shared.ts";

// The built-in `apply` workflow: it observes the declared resources as drift does, plans what
// would make each match its declaration, asks one approval wherever the policy holds a change,
// then makes the changes in dependency order, keeping the lockfile's bindings as it goes. It is a
// workflow like any other, held to the same lint, so every vendor call goes through `ctx`. Only
// it may call a writable type's change operations (`isChangeOp`).

/** What a person answers for a bound object the vendor no longer has (`gone`), or a binding no declaration has (`orphan`). */
export const PLAN_ANSWERS = ["recreate", "forget", "delete"] as const;
export type PlanAnswer = (typeof PLAN_ANSWERS)[number];

/**
 * The apply workflow's input: `only` the declared ids (`<file>#<export>`) or orphaned lockfile
 * keys to plan, else all; `bind`, a declared id to the vendor's id of the object to bind it to;
 * `answers`, by declared id or orphaned key: `recreate` or `forget` a gone object, `forget` or
 * `delete` an orphaned binding's.
 */
export const ApplyInput = z.strictObject({
  only: z.array(z.string()).optional(),
  bind: z.record(z.string(), z.string().min(1)).optional(),
  answers: z.record(z.string(), z.enum(PLAN_ANSWERS)).optional(),
});
export type ApplyInput = z.infer<typeof ApplyInput>;

/**
 * One declared resource, or orphaned binding, by what apply does with it: `create` it (as the
 * vendor plans: `planned`, the paths `unknown` until it exists), `update` or `replace` its bound
 * object (the declared `fields` that differ, the paths that force the replace), `bind` it to an
 * object its identity `found` or the input `given`, ask about a `gone` object or an `orphan`ed
 * binding (unless `answer`ed), or `none`.
 */
export type PlanStep = { id: string; vendor: string; type: string } & (
  | { action: "create"; planned: Record<string, unknown>; unknown: string[] }
  | { action: "update" | "replace"; binding: string; fields: DriftField[]; replace: string[] }
  | { action: "bind"; binding: string; source: "found" | "given" }
  | { action: "gone"; binding: string; answer?: PlanAnswer }
  | { action: "orphan"; key: string; binding: string; answer?: PlanAnswer }
  | { action: "none"; binding: string }
);

/** What apply would change: the problems, the lockfile's changes it did not make, and each step in dependency order. */
export interface ApplyPlan {
  problems: ResourceProblem[];
  /** The committed lockfile against the one apply last wrote: changes someone else made. */
  rebinds: Rebind[];
  steps: PlanStep[];
}

/** What became of one step: `done` (a `none` too), `skipped` (a question unanswered), or `failed`, with why. */
export interface ApplyResult {
  id: string;
  action: PlanStep["action"];
  status: "done" | "skipped" | "failed";
  /** Its binding after the step, when it has one. */
  binding?: string;
  error?: string;
}

/** The apply workflow's output. */
export interface ApplyReport {
  plan: ApplyPlan;
  results: ApplyResult[];
  /**
   * Whether the run wrote the lockfile (a sandbox run keeps its copy in memory), the revision of
   * its last commit, and the bindings it ended with.
   */
  lockfile: { written: boolean; revision?: string; bindings: Bindings };
}

/** What an apply run reads first: the data files and the lockfile, as drift does, and the lockfile's rebinds. */
export interface ApplyDeclared extends DriftDeclared {
  bindings: Bindings;
  orphans: (Binding & { key: string })[];
  rebinds: Rebind[];
}

/** One change call apply plans to make, as the policy would see it. */
export interface PlannedCall {
  op: string;
  input: unknown;
}

/** What apply does that is no vendor call, each a step of its own (`apply-steps.ts`). */
export interface ApplySteps {
  declared(): Promise<ApplyDeclared>;
  /** Who the policy would hold any of these calls for, the first it holds; undefined when it holds none. */
  holds(calls: PlannedCall[]): Promise<Approver | undefined>;
  /**
   * Binds `key` to `binding` (unbinds it when undefined) in the lockfile as it is now, so a change
   * another run made since this one read it stays, and commits it with `message`; a sandbox run
   * writes nothing.
   */
  write(key: string, binding: Binding | undefined, message: string): Promise<{ written: boolean; revision?: string }>;
}

type State = Record<string, unknown>;
type Declaration = ApplyDeclared["resources"][number];
type Expect = { action: PlanAction; replace: string[] };
// A resource type's operations, as `ctx` gives them: by vendor and type, both only known per run.
type ImportOp = Op<string, string, "import", { id: string }, { id: string; gone: boolean; state?: State }>;
type PlanOp = Op<
  string,
  string,
  "plan",
  { id?: string; desired?: State },
  { action: PlanAction; planned?: State; unknown: string[]; replace: string[] }
>;
type CreateOp = Op<string, string, "create", { desired: State }, { id: string; state: State }>;
type UpdateOp = Op<string, string, "update", { id: string; desired: State; expect?: Expect }, { id: string }>;
type DeleteOp = Op<string, string, "delete", { id: string }, { id: string; gone: true }>;
type ApplyUse = ImportOp | PlanOp | CreateOp | UpdateOp | DeleteOp | ResolveOp | "approval";

/** What a step's resource is called in a problem: its file, and its export. */
const problemOf = (id: string, message: string): ResourceProblem => ({
  file: id.slice(0, id.indexOf("#")),
  message: `${id.slice(id.indexOf("#") + 1)}: ${message}`,
});

/** Each resource after the ones it names, otherwise in the files' order. */
function inDependencyOrder<T extends { id: string; refs: Record<string, string> }>(list: readonly T[]): T[] {
  const byId = new Map(list.map((r) => [r.id, r]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (r: T) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    for (const target of Object.values(r.refs)) {
      const named = byId.get(target);
      if (named) visit(named);
    }
    out.push(r);
  };
  list.forEach(visit);
  return out;
}

/**
 * What a change operation is given of a declaration: its fields, where it names a resource the
 * vendor may hold by another field (`by`, as a repository's node id), that resource's binding id
 * when it has one, made in this run or before.
 */
function desiredOf(
  r: Declaration,
  types: ReadonlyMap<string, Resource>,
  bindings: Bindings,
  hosts: ReadonlyMap<string, { source: string; revision: string }>,
): State {
  const { fields, host } = types.get(`${r.vendor}.${r.type}`)!;
  const { references = {} } = fields;
  const out = structuredClone(r.desired);
  for (const [at, target] of Object.entries(r.refs)) {
    const bound = bindings[target]?.id;
    const place = holderOf(out, at);
    if (references[fieldPathOf(at)]?.by?.length && bound !== undefined && place) place.holder[place.key] = bound;
  }
  // A host is given its source's clone URL and the commit its ref names now.
  const run = hosts.get(r.id);
  if (host && run) {
    for (const [path, value] of [
      [host.inputs.source, run.source],
      [host.revision, run.revision],
    ] as const) {
      const place = holderOf(out, path);
      if (place) place.holder[place.key] = value;
    }
  }
  return out;
}

/** Why apply cannot `what` (create, update, delete) an object of a type. */
const cannotChange = (type: Pick<Resource, "vendor" | "type" | "writable"> | undefined, what: string) =>
  type?.writable
    ? `apply cannot ${what} a ${type.vendor}.${type.type}: no driver does`
    : `apply cannot ${what} it: ${type ? `a ${type.vendor}.${type.type}` : "its type"} is read-only`;

/** The ids in `list` that `known` refuses, as problems of the input's field `what`. */
const unknown = (what: string, list: readonly string[], known: (id: string) => boolean): ResourceProblem[] =>
  list.filter((id) => !known(id)).map((id) => ({ message: `${what}: ${id} is no declared resource` }));

/** What the input names that is neither declared nor an orphaned binding. */
function inputProblems(
  input: ApplyInput,
  ids: ReadonlyMap<string, unknown>,
  orphans: ReadonlySet<string>,
): ResourceProblem[] {
  return [
    ...unknown("only", input.only ?? [], (id) => ids.has(id) || orphans.has(id)),
    ...unknown("bind", Object.keys(input.bind ?? {}), (id) => ids.has(id)),
    ...unknown("answers", Object.keys(input.answers ?? {}), (id) => ids.has(id) || orphans.has(id)),
  ];
}

/**
 * What to do with one declared resource, from what observing it found: a step, a problem, or
 * both, or `ask`: the input to its type's `plan`, whose answer `fromPlan` reads.
 */
function decide(
  r: Declaration,
  result: DriftResult,
  now: Found,
  input: ApplyInput,
  desired: State,
  types: ReadonlyMap<string, Resource>,
  usable: ReadonlySet<string>,
): { step?: PlanStep; problem?: ResourceProblem; ask?: { id?: string; desired: State } } {
  const head = { id: r.id, vendor: r.vendor, type: r.type };
  const key = `${r.vendor}.${r.type}`;
  const may = (name: string) => usable.has(`${key}.${name}`);
  const cannot = (what: string) => problemOf(r.id, cannotChange(types.get(key)!, what));
  const given = input.bind?.[r.id];
  if (given !== undefined) {
    if (!("state" in now))
      return { problem: problemOf(r.id, "error" in now ? now.error : `no ${key} ${given} to bind`) };
    return { step: { ...head, action: "bind", binding: types.get(key)!.bindingId(now.state), source: "given" } };
  }
  if (result.status === "error") return { problem: problemOf(r.id, result.error ?? "could not be read") };
  if (result.status === "absent") {
    if (result.found !== undefined)
      return { step: { ...head, action: "bind", binding: result.found, source: "found" } };
    return may("create") ? { ask: { desired } } : { problem: cannot("create") };
  }
  const binding = result.binding!;
  if (result.status === "gone") {
    const answer = input.answers?.[r.id];
    // An object that holds no data is made again, unless answered otherwise; anything else, a person decides.
    if (answer === undefined && types.get(key)!.stateless && may("create")) return { ask: { desired } };
    const step: PlanStep = { ...head, action: "gone", binding };
    if (answer === "recreate" && !may("create")) return { step, problem: cannot("create") };
    if (answer === "recreate" || answer === "forget") return { step: { ...step, answer } };
    return answer === undefined
      ? { step }
      : { step, problem: problemOf(r.id, `a gone object is recreated or forgotten, not ${answer}d`) };
  }
  if (may("plan")) return { ask: { id: binding, desired } };
  const step: PlanStep = { ...head, action: "none", binding };
  return result.status === "drifted" ? { step, problem: cannot("update") } : { step };
}

/** The step a `plan` answer makes of a declared resource: a create for one unbound or gone, else an update, a replace or none. */
function fromPlan(
  r: Declaration,
  result: DriftResult,
  p: { action: PlanAction; planned?: State; unknown: string[]; replace: string[] },
): { step?: PlanStep; problem?: ResourceProblem } {
  const head = { id: r.id, vendor: r.vendor, type: r.type };
  const creating = result.status === "absent" || result.status === "gone";
  if (creating && p.action === "create") {
    return { step: { ...head, action: "create", planned: p.planned ?? {}, unknown: p.unknown } };
  }
  if (!creating && (p.action === "update" || p.action === "replace")) {
    return { step: { ...head, action: p.action, binding: result.binding!, fields: result.fields, replace: p.replace } };
  }
  if (!creating && p.action === "none") return { step: { ...head, action: "none", binding: result.binding! } };
  return { problem: problemOf(r.id, `the vendor plans to ${p.action} it, which apply does not do here`) };
}

/** Each orphaned binding the input wants, after the declarations, and the answers that cannot be done. */
function orphansOf(
  orphans: ApplyDeclared["orphans"],
  input: ApplyInput,
  wanted: (id: string) => boolean,
  usable: ReadonlySet<string>,
  types: ReadonlyMap<string, Resource>,
): { steps: PlanStep[]; problems: ResourceProblem[] } {
  const steps: PlanStep[] = [];
  const problems: ResourceProblem[] = [];
  for (const { key, type, id } of orphans.filter((o) => wanted(o.key))) {
    const answer = input.answers?.[key];
    const [vendor = "", name = ""] = type.split(".");
    const step = { id: key, vendor, type: name, action: "orphan" as const, key, binding: id };
    const why =
      answer === "recreate"
        ? "an orphaned binding is forgotten or its object deleted, not recreated"
        : answer === "delete" && !usable.has(`${type}.delete`)
          ? cannotChange(types.get(type), "delete")
          : undefined;
    if (why) problems.push(problemOf(key, why));
    steps.push(answer === undefined || why ? step : { ...step, answer });
  }
  return { steps, problems };
}

/** What running a step does: a change operation, a change to the lockfile only, nothing, or nothing as it waits for an answer. */
function runOf(step: PlanStep): "create" | "update" | "delete" | "bind" | "forget" | "none" | "skip" {
  switch (step.action) {
    case "create":
      return "create";
    case "update":
    case "replace":
      return "update";
    case "bind":
    case "none":
      return step.action;
    case "gone":
      return step.answer === "recreate" ? "create" : step.answer === "forget" ? "forget" : "skip";
    case "orphan":
      return step.answer === "delete" ? "delete" : step.answer === "forget" ? "forget" : "skip";
  }
}

/** The change calls the plan would make, as the policy would see them, with the declarations' fields as planned. */
function writesOf(plan: ApplyPlan, desired: ReadonlyMap<string, State>): PlannedCall[] {
  return plan.steps.flatMap((step): PlannedCall[] => {
    const at = `${step.vendor}.${step.type}`;
    const run = runOf(step);
    if (run === "create") return [{ op: `${at}.create`, input: { desired: desired.get(step.id) } }];
    if (run === "delete" && "binding" in step) return [{ op: `${at}.delete`, input: { id: step.binding } }];
    if (run !== "update" || (step.action !== "update" && step.action !== "replace")) return [];
    const expect = { action: step.action, replace: step.replace };
    return [{ op: `${at}.update`, input: { id: step.binding, desired: desired.get(step.id), expect } }];
  });
}

/** The lockfile's key a step binds: a declaration's id, or an orphan's key. */
const keyOf = (step: PlanStep) => (step.action === "orphan" ? step.key : step.id);

/** The commit message for a step's change to the lockfile. */
function messageOf(step: PlanStep, before: Binding | undefined, after: Binding | undefined): string {
  const key = keyOf(step);
  if (!after) return `Apply: unbind ${key} (${before?.type} ${before?.id})`;
  const what = runOf(step) === "create" ? "create" : before ? "rebind" : "bind";
  return `Apply: ${what} ${key} (${after.type} ${after.id})`;
}

/**
 * The apply workflow for a config: it `uses` the `import` of every resource type the connectors
 * declare that has a driver, and the change operations (`plan`, `create`, `update`, `delete`) of
 * each writable one, and `approval`. `resolveConfig` adds it beside drift, with `steps`, the
 * steps that read the data files, ask the policy and write the lockfile.
 *
 * A run reads the data files, the lockfile and its rebinds (`steps.declared`), and observes each
 * declared resource as drift does: one import each, by the binding the input gives, else the
 * lockfile's, else its identity. Then, for each resource the input wants (`only`), each after the
 * ones it names, it plans:
 *
 * - `bind` when the input gives an object (`bind`) or, unbound, its identity finds one;
 * - `create` when unbound and nothing is found, as its type's `plan` says (a gone object of a
 *   `stateless` type too, unless answered);
 * - `gone` when its bound object is no longer there: skipped unless `answers` says `recreate`
 *   (created again) or `forget` (unbound);
 * - `update`, `replace` or `none`, as its type's `plan` says for its bound object;
 * - `orphan` for a binding no declaration has: skipped unless `answers` says `forget` (unbound) or
 *   `delete` (deleted at the vendor, then unbound).
 *
 * What cannot be planned is a problem, and has no step. When the policy would hold any of the
 * change calls the plan makes (`steps.holds`), one approval asks for them all, covering each
 * change operation, with the plan as its details. Then each step runs in order: a change call,
 * and right after one that changes a binding, the lockfile written and committed
 * (`steps.write`), so an object made is never left unbound. An update is given the plan's action
 * and replace (`expect`), and refuses (`plan_changed`) when the vendor now plans otherwise; a
 * reference to a resource made in this run is given its new binding. A failed step is reported
 * and the run goes on; a failure that ends the run (`isRunControlError`) ends it.
 */
export function applyWorkflow(
  types: ReadonlyMap<string, Resource>,
  ops: ReadonlyMap<string, Op>,
  drivers: ReadonlyMap<string, unknown>,
  steps: ApplySteps,
): WorkflowDefinition<readonly ApplyUse[], typeof ApplyInput> {
  const imports = importsOf(types, ops, drivers);
  const changes = [...types.values()]
    .filter((r) => r.writable)
    .flatMap((r) => ["plan", "create", "update", "delete"].map((name) => ops.get(`${r.vendor}.${r.type}.${name}`)))
    .filter((op): op is Op => op !== undefined && drivers.has(op.id))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const usable = new Set(changes.map((op) => op.id));
  const resolve = ops.get(SOURCE_RESOLVE) as ResolveOp | undefined;
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "apply" satisfies typeof APPLY_WORKFLOW,
    title: "Apply resources",
    trigger: "manual",
    input: ApplyInput,
    uses: [
      ...imports,
      ...(changes as (PlanOp | CreateOp | UpdateOp | DeleteOp)[]),
      ...(resolve ? [resolve] : []),
      "approval",
    ],
    run: async (ctx, input) => {
      const { resources, problems: read, bindings: locked, orphans, rebinds } = await steps.declared();
      const wanted = (id: string) => input.only === undefined || input.only.includes(id);
      const declarations = new Map(resources.map((r) => [r.id, r]));
      const problems = [...read, ...inputProblems(input, declarations, new Set(orphans.map((o) => o.key)))];
      // Observed as drift does, every import first, by the binding given before the lockfile's.
      const found = new Map<string, Found>();
      for (const resource of resources) {
        const by = observeBy(
          resource,
          types,
          imports,
          input.bind?.[resource.id] ?? resource.binding ?? resource.identity,
        );
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
      // A host wanted runs the commit its ref names now, resolved before planning: a merge is a change
      // to it. One bound by the input needs none.
      const revisions = new Map<string, Revision>();
      const hosts = new Map<string, { source: string; revision: string }>();
      for (const { id, vendor, type, desired, refs } of resources.filter(
        (r) => wanted(r.id) && input.bind?.[r.id] === undefined,
      )) {
        const resource = types.get(`${vendor}.${type}`);
        const host = resource?.host;
        const source = host && sourceUrl(desired, refs[host.inputs.source], resource, found);
        const ref = host && valueAt(desired, host.inputs.ref);
        if (host && source !== undefined && typeof ref === "string" && ref) {
          try {
            const { revision } = await ctx.sanoma!.source!.resolve({ url: source, ref });
            revisions.set(id, { revision });
            hosts.set(id, { source, revision });
          } catch (err) {
            if (isRunControlError(err)) throw err;
            revisions.set(id, { error: errorMessage(err) });
          }
        }
      }
      const drift = new Map(compare(types, resources, found, revisions).map((result) => [result.id, result]));
      const desired = new Map(resources.map((r) => [r.id, desiredOf(r, types, locked, hosts)]));

      const planned: PlanStep[] = [];
      for (const resource of inDependencyOrder(resources).filter((r) => wanted(r.id))) {
        const result = drift.get(resource.id)!;
        const unresolved = revisions.get(resource.id);
        // A host whose ref could not be resolved has no commit to run (compare says so only for one it found).
        const next =
          unresolved && "error" in unresolved && result.status !== "error"
            ? { problem: problemOf(resource.id, unresolved.error) }
            : decide(resource, result, found.get(resource.id)!, input, desired.get(resource.id)!, types, usable);
        if (next.ask !== undefined) {
          try {
            const answer = fromPlan(resource, result, await ctx[resource.vendor]![resource.type]!.plan(next.ask));
            if (answer.step) planned.push(answer.step);
            if (answer.problem) problems.push(answer.problem);
          } catch (err) {
            if (isRunControlError(err)) throw err;
            problems.push(problemOf(resource.id, `could not be planned: ${errorMessage(err)}`));
          }
        }
        if (next.step) planned.push(next.step);
        if (next.problem) problems.push(next.problem);
      }
      const orphaned = orphansOf(orphans, input, wanted, usable, types);
      const plan: ApplyPlan = {
        problems: [...problems, ...orphaned.problems],
        rebinds,
        steps: [...planned, ...orphaned.steps],
      };

      const writes = writesOf(plan, desired);
      const approver = writes.length ? await steps.holds(writes) : undefined;
      if (approver !== undefined) {
        const covers = [...new Set(writes.map((w) => w.op))].map((id) => ops.get(id)!);
        await ctx.approval("Apply resource changes", { approver, covers, details: JSON.stringify(plan, null, 2) });
      }

      const bindings: Bindings = { ...locked };
      const results: ApplyResult[] = [];
      let written = false;
      let revision: string | undefined;
      for (const step of plan.steps) {
        const todo = runOf(step);
        const key = keyOf(step);
        const type = `${step.vendor}.${step.type}`;
        const before = bindings[key];
        const binding = "binding" in step ? step.binding : "";
        const declared = declarations.get(step.id);
        try {
          if (todo === "create") {
            const made = await ctx[step.vendor]![step.type]!.create({
              desired: desiredOf(declared!, types, bindings, hosts),
            });
            bindings[key] = { type, id: made.id };
          } else if (todo === "update" && (step.action === "update" || step.action === "replace")) {
            const expect = { action: step.action, replace: step.replace };
            const changed = await ctx[step.vendor]![step.type]!.update({
              id: binding,
              desired: desiredOf(declared!, types, bindings, hosts),
              expect,
            });
            bindings[key] = { type, id: changed.id };
          } else if (todo === "delete") {
            await ctx[step.vendor]![step.type]!.delete({ id: binding });
            delete bindings[key];
          } else if (todo === "bind") bindings[key] = { type, id: binding };
          else if (todo === "forget") delete bindings[key];
          const after = bindings[key];
          if (after?.id !== before?.id) {
            const wrote = await steps.write(key, after, messageOf(step, before, after));
            written ||= wrote.written;
            revision = wrote.revision ?? revision;
          }
          results.push({
            id: step.id,
            action: step.action,
            status: todo === "skip" ? "skipped" : "done",
            ...(after && { binding: after.id }),
          });
        } catch (err) {
          if (isRunControlError(err)) throw err;
          const left = bindings[key];
          results.push({
            id: step.id,
            action: step.action,
            status: "failed",
            ...(left && { binding: left.id }),
            error: errorMessage(err),
          });
        }
      }
      const lockfile = { written, ...(revision !== undefined && { revision }), bindings };
      return { plan, results, lockfile } satisfies ApplyReport;
    },
  });
}
