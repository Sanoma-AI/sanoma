import type { z } from "zod";
import type { SanomaConfig } from "./config.ts";
import { hasPath } from "./host.ts";
import type { Op } from "./op.ts";
import type { Resource } from "./resource.ts";
import type { DeclaredResource } from "./resources.ts";

// The `Wakeup` contract: what a resource type that wakes a stopped instance at a time declares
// about itself, beside `Host`. Declaring one in a data file is the whole switch: the worker then
// registers its next deadline with it before it stops, and the wakeup calls the host's
// `GET {url}/wake?generation=N` then. Only the contract is here; the worker's side comes later.

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

/**
 * Throws what is wrong with a resource type's `wakeup`: a type apply cannot change (not
 * `writable`), a `host` that names no field or no reference, a `register` that is not an
 * operation of the type's own group, `outputs` that is not a function. Whether the connector
 * has that operation is `checkWakeupOps`'s, which `resolveConfig` runs.
 */
export function checkWakeup(
  what: string,
  wakeup: WakeupSpec,
  type: {
    vendor: string;
    type: string;
    schema: z.ZodObject;
    fields: { references?: Readonly<Record<string, unknown>> };
    writable?: boolean;
  },
): void {
  const problems: string[] = [];
  if (!type.writable) problems.push("it must be writable, so apply can create and update it");
  const host = wakeup.inputs?.host;
  if (typeof host !== "string" || !hasPath(type.schema, host)) problems.push(`inputs.host names no field (${host})`);
  else if (!Object.hasOwn(type.fields.references ?? {}, host))
    problems.push(`inputs.host must be a reference to the host (fields.references), not ${host}`);
  const group = `${type.vendor}.${type.type}.`;
  const register: unknown = wakeup.register;
  if (typeof register !== "string" || !register.startsWith(group) || !/^\w+$/.test(register.slice(group.length)))
    problems.push(`register must name an operation of its own group, ${group}<op> (${String(register)})`);
  if (typeof wakeup.outputs !== "function") problems.push("outputs must be a function of the state");
  if (problems.length) throw new Error(`${what}: its wakeup: ${problems.join("; ")}`);
}

/** A registration every register operation must take: the input `checkWakeupOps` tries. */
const SAMPLE: WakeupRegistration = { at: new Date(0).toISOString(), generation: 1 };

/**
 * Throws when a wakeup type's `register` is not among the config's operations, or does not take
 * `WakeupRegistration`. Here rather than in `defineConnector`, which sees one connector before
 * its package merges in the operations it adds to a resource's group (Supabase's pattern).
 */
export function checkWakeupOps(types: ReadonlyMap<string, Resource>, ops: ReadonlyMap<string, Op>): void {
  for (const [id, type] of types) {
    if (!type.wakeup) continue;
    const op = ops.get(type.wakeup.register);
    if (!op) throw new Error(`${id}: its wakeup's register, ${type.wakeup.register}, is no operation of its connector`);
    if (!op.input.safeParse(SAMPLE).success)
      throw new Error(`${id}: its wakeup's register, ${op.id}, must take { at, generation }`);
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
}

/** Each declared resource whose type carries a `wakeup`, in the data files' order. */
export function wakeupsAmong(
  resources: readonly DeclaredResource[],
  types: ReadonlyMap<string, Resource>,
): DeclaredWakeup[] {
  return resources.flatMap((declared) => {
    const type = types.get(`${declared.vendor}.${declared.type}`);
    if (!type?.wakeup) return [];
    return [{ id: declared.id, type, declared, ...(declared.binding !== undefined && { binding: declared.binding }) }];
  });
}

/** The problem at each of several declared wakeups, `describeConfig`'s: an instance has one. */
export const twoWakeups = (others: readonly string[]): string =>
  `an instance has one wakeup: leave out this one or ${others.join(", ")}`;

/** Every wakeup the config's data files declare, read without running them (server-side). */
export async function declaredWakeups(config: SanomaConfig): Promise<DeclaredWakeup[]> {
  // Loaded here, not with this module: `resource.ts` imports it, and the reader loads oxc.
  const [{ readDataFiles }, { connectorsOf, rootOf }, { resourceTypesOf }] = await Promise.all([
    import("./resources.ts"),
    import("./config.ts"),
    import("./resource.ts"),
  ]);
  const connectors = connectorsOf(config);
  const types = resourceTypesOf(connectors);
  return wakeupsAmong(readDataFiles(rootOf(config), connectors, types).resources, types);
}

/**
 * The one wakeup the config's data files declare, or undefined: with none, and with several,
 * which `describeConfig` reports as a problem at each. Server-side: it reads the data files and
 * the lockfile.
 */
export async function declaredWakeup(config: SanomaConfig): Promise<DeclaredWakeup | undefined> {
  const found = await declaredWakeups(config);
  return found.length === 1 ? found[0] : undefined;
}
