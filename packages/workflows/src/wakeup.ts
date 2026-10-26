import type { z } from "zod";
import { hasPath } from "./host.ts";
import type { Op } from "./op.ts";
import type { References, Resource } from "./resource.ts";
import type { DeclaredResource } from "./resources.ts";

// The `Wakeup` contract: what a resource type that wakes a stopped instance at a time declares
// about itself, beside `Host`. Declaring one in a data file is the whole switch: the worker then
// registers its next deadline with it before it stops, and the wakeup calls the host's
// `GET {url}/wake?generation=N` then. The contract is here; the worker's side is `deadlines.ts`.

/** What a wakeup's state says of it. */
export interface WakeupOutputs {
  healthy: boolean;
}

/** What the runtime calls a wakeup's `register` operation with. */
export interface WakeupRegistration {
  /** When to wake the instance, as an ISO 8601 date-time. */
  at: string;
  /** Counts up with each registration: one with a newer generation replaces the older. */
  generation: number;
}

/**
 * The `generation` of a `GET /wake?generation=N` request: a non-negative integer, in digits
 * alone; undefined for none or any other.
 */
export function wakeGeneration(url: string | URL): number | undefined {
  const given = new URL(url).searchParams.get("generation") ?? "";
  const generation = Number(given);
  return /^\d+$/.test(given) && Number.isSafeInteger(generation) ? generation : undefined;
}

/**
 * A resource type's `wakeup`: the field it names the host in, the operation the runtime
 * registers each deadline through, and how its state reads.
 */
export interface WakeupSpec {
  inputs: {
    /**
     * The dotted path of the declared field that names the host's declaration: a
     * `fields.references` entry, resolved `by` a field of the host's state holding its URL.
     */
    host: string;
  };
  /**
   * The id of the type's own register operation, `<vendor>.<type>.<op>`: an operation in the
   * type's own group of its connector, beside `read` and `import` (the way Supabase adds
   * `project.health` beside `project`). The runtime calls it with `WakeupRegistration`,
   * at least once per registration; a newer `generation` replaces the older.
   */
  register: string;
  outputs: (state: Record<string, unknown>) => WakeupOutputs;
}

/** The operations `defineResource` gives a type itself: never its register. */
const RESOURCE_OPS = new Set(["read", "import", "plan", "create", "update", "delete"]);

/**
 * Throws what is wrong with a resource type's `wakeup`: a type apply cannot change (not
 * `writable`), a host (stopped when its wake is due), a `host` that names no field or no
 * reference resolved `by` a field, a `register` that is not an operation of the type's own group
 * or is one of its resource operations, `outputs` that is not a function. Whether the connector
 * has that operation, and the reference names a host, is `checkWakeupOps`'s, which
 * `resolveConfig` runs.
 */
export function checkWakeup(
  what: string,
  wakeup: WakeupSpec,
  type: {
    vendor: string;
    type: string;
    schema: z.ZodObject;
    fields: { references?: References };
    writable?: boolean;
    host?: unknown;
  },
): void {
  const problems: string[] = [];
  if (!type.writable) problems.push("it must be writable, so apply can create and update it");
  if (type.host) problems.push("a host cannot be its own wakeup: it is stopped when the wake is due");
  const host = wakeup.inputs?.host;
  const reference = typeof host === "string" ? type.fields.references?.[host] : undefined;
  if (typeof host !== "string" || !hasPath(type.schema, host)) problems.push(`inputs.host names no field (${host})`);
  else if (!reference) problems.push(`inputs.host must be a reference to the host (fields.references), not ${host}`);
  else if (!reference.by?.length)
    problems.push("inputs.host must be resolved `by` the field of the host's state that holds its URL");
  const group = `${type.vendor}.${type.type}.`;
  const register: unknown = wakeup.register;
  const name = typeof register === "string" && register.startsWith(group) ? register.slice(group.length) : "";
  if (!/^\w+$/.test(name))
    problems.push(`register must name an operation of its own group, ${group}<op> (${String(register)})`);
  else if (RESOURCE_OPS.has(name)) problems.push(`register must be an operation of its own, not the type's ${name}`);
  if (typeof wakeup.outputs !== "function") problems.push("outputs must be a function of the state");
  if (problems.length) throw new Error(`${what}: its wakeup: ${problems.join("; ")}`);
}

/** A registration every register operation must take: the input `checkWakeupOps` tries. */
const SAMPLE: WakeupRegistration = { at: new Date(0).toISOString(), generation: 1 };

/** True when `op`'s input keeps both fields of a registration: one that strips them takes neither. */
function takesRegistration(op: Op): boolean {
  try {
    const parsed = op.input.safeParse(SAMPLE);
    const data = parsed.data as Partial<WakeupRegistration> | undefined;
    return parsed.success && data?.at !== undefined && data.generation !== undefined;
  } catch {
    // An async refinement, which a sync parse cannot run: no input the runtime can check.
    return false;
  }
}

/** The host types a wakeup type may name: its `inputs.host` reference's. */
export const wakeupHostTypes = (type: Pick<Resource, "fields" | "wakeup">): string[] =>
  type.wakeup ? [type.fields.references?.[type.wakeup.inputs.host]?.type ?? []].flat() : [];

/**
 * Throws when a wakeup type's host reference names a type of the config that is no host, or its
 * `register` is not among the config's operations, or does not take
 * `WakeupRegistration`. Here rather than in `defineConnector`, which sees one connector before
 * its package merges in the operations it adds to a resource's group (Supabase's pattern).
 */
export function checkWakeupOps(types: ReadonlyMap<string, Resource>, ops: ReadonlyMap<string, Op>): void {
  for (const [id, type] of types) {
    if (!type.wakeup) continue;
    // The types it may name that the config has, each a host; one it lacks no data file can declare.
    const notHosts = wakeupHostTypes(type).filter((t) => types.has(t) && !types.get(t)!.host);
    if (notHosts.length) throw new Error(`${id}: its wakeup's host may name ${notHosts.join(", ")}, which is no host`);
    const op = ops.get(type.wakeup.register);
    if (!op) throw new Error(`${id}: its wakeup's register, ${type.wakeup.register}, is no operation of its connector`);
    if (!takesRegistration(op)) throw new Error(`${id}: its wakeup's register, ${op.id}, must take { at, generation }`);
  }
}

/** The one wakeup the data files declare: its declaration, its type, and its binding when it is bound. */
export interface DeclaredWakeup {
  /** `<file>#<export>`, as `DeclaredResource.id`. */
  id: string;
  type: Resource;
  declared: DeclaredResource;
  /** The vendor's id of the object the lockfile binds it to; absent when unbound. */
  binding?: string;
  /** The declared host its `inputs.host` names: its declaration's id and its type, a host's (`checkWakeupOps`). */
  host?: { id: string; type: Resource };
}
