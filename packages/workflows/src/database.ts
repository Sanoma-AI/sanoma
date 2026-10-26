import type { z } from "zod";
import { hasPath } from "./host.ts";
import type { Op } from "./op.ts";
import type { AfterCreate, Resource } from "./resource.ts";
import { RESOURCE_OPS } from "./wakeup.ts";

// The `Database` contract: what a resource type that holds the company's database (a Neon
// project, a Supabase project) declares about itself, beside `Host` and `Wakeup`, so databases
// are swappable and one conformance kit decides whether one works. Going live chooses one by it.

/** What a database can do, for choosing one: declared, never checked at runtime. */
export interface DatabaseCapabilities {
  /** Its compute scales to zero and wakes on the next connection (Neon's). */
  pauses: boolean;
  /** It makes copy-on-write branches that carry the data, each with its own URL. */
  branch: boolean;
}

/** What a database's state says of it. */
export interface DatabaseOutputs {
  healthy: boolean;
}

/**
 * A resource type's `database`: the fields it takes going live's choices in, by dotted path into
 * its declared fields, the operation that stores its URL, and how its state reads.
 */
export interface DatabaseSpec {
  capabilities: DatabaseCapabilities;
  inputs: {
    /** Where it runs, one of `regions` when the type lists them. */
    region: string;
    /** Its compute's size, when the vendor takes one: absent for its default. */
    size?: string;
  };
  /**
   * The id of the operation that stores the database's URL, `<vendor>.<group>.<op>`, an
   * operation of the type's own vendor: in the type's own group beside `read` and `import`
   * (`neon.project.storeUrl`), or in a group of its own (`supabase.database.storeUrl`, which
   * predates the contract), never a resource type's own operation. It takes the new object's
   * binding id as `ref` or `id` and the data file's export as `export`, and stores the URL that
   * carries `LISTEN` (the direct one, or a session pooler's; never a transaction-mode pooler's)
   * as the secret `SANOMA_DATABASE_URL_<EXPORT>`, never returning it. The type's `afterCreate`
   * calls it, so apply stores the URL once it makes the database.
   */
  storeUrl: string;
  /** The regions `inputs.region` takes, for a choice; absent when the vendor's list is not known here. */
  regions?: readonly string[];
  outputs: (state: Record<string, unknown>) => DatabaseOutputs;
}

/**
 * Throws what is wrong with a resource type's `database`: a type apply cannot change (not
 * `writable`), one apply may recreate without asking (`stateless`: a database holds data), an
 * input that names no field, a capability that is not a boolean, a `storeUrl` that is not an
 * operation of its vendor or is one of the type's resource operations, or that `afterCreate`
 * does not call, `regions` that is not a list of strings, `outputs` that is not a function.
 * Whether the connector has that operation, and it takes `{ ref | id, export }`, is
 * `checkDatabaseOps`'s, which `resolveConfig` runs.
 */
export function checkDatabase(
  what: string,
  database: DatabaseSpec,
  type: {
    vendor: string;
    type: string;
    schema: z.ZodObject;
    writable?: boolean;
    stateless?: boolean;
    afterCreate?: readonly AfterCreate[];
  },
): void {
  const problems: string[] = [];
  if (!type.writable) problems.push("it must be writable, so apply can create and update it");
  if (type.stateless) problems.push("it must not be stateless: it holds data, so apply asks before it deletes one");
  const capabilities: Partial<DatabaseCapabilities> = database.capabilities ?? {};
  for (const name of ["pauses", "branch"] as const) {
    if (typeof capabilities[name] !== "boolean") problems.push(`capabilities.${name} must be true or false`);
  }
  const { region, size } = database.inputs ?? {};
  if (typeof region !== "string" || !hasPath(type.schema, region)) problems.push(`region names no field (${region})`);
  if (size !== undefined && !hasPath(type.schema, size)) problems.push(`size names no field (${size})`);
  const storeUrl: unknown = database.storeUrl;
  const [vendor, group, name, ...more] = typeof storeUrl === "string" ? storeUrl.split(".") : [];
  if (vendor !== type.vendor || !/^\w+$/.test(group ?? "") || !/^\w+$/.test(name ?? "") || more.length) {
    problems.push(`storeUrl must name an operation of its vendor, ${type.vendor}.<group>.<op> (${String(storeUrl)})`);
  } else if (group === type.type && RESOURCE_OPS.has(name!)) {
    problems.push(`storeUrl must be an operation of its own, not the type's ${name}`);
  } else if (!type.afterCreate?.some((step) => step.op === storeUrl)) {
    problems.push(`afterCreate must call ${storeUrl}, so apply stores the URL once it makes one`);
  }
  if (
    database.regions !== undefined &&
    (!Array.isArray(database.regions) || database.regions.some((r) => typeof r !== "string" || !r))
  ) {
    problems.push("regions must be a list of region names");
  }
  if (typeof database.outputs !== "function") problems.push("outputs must be a function of the state");
  if (problems.length) throw new Error(`${what}: its database: ${problems.join("; ")}`);
}

/**
 * Throws when a database type's `storeUrl` is not among the config's operations, is one of a
 * resource type's own, or does not take `{ ref | id, export }`. Here rather than in
 * `defineResource`, which sees one type before its package merges in the operations it adds
 * (Supabase's pattern), as `checkWakeupOps`.
 */
export function checkDatabaseOps(types: ReadonlyMap<string, Resource>, ops: ReadonlyMap<string, Op>): void {
  for (const [id, type] of types) {
    if (!type.database) continue;
    const op = ops.get(type.database.storeUrl);
    if (!op)
      throw new Error(`${id}: its database's storeUrl, ${type.database.storeUrl}, is no operation of its connector`);
    if (types.has(`${op.vendor}.${op.resource}`) && RESOURCE_OPS.has(op.name)) {
      throw new Error(`${id}: its database's storeUrl, ${op.id}, is a resource type's own operation`);
    }
    // By its fields, not a sample's parse: an id or export with a format of its own is still one.
    const shape = (op.input as { shape?: Record<string, unknown> }).shape ?? {};
    if (!("export" in shape && ("ref" in shape || "id" in shape)))
      throw new Error(`${id}: its database's storeUrl, ${op.id}, must take { ref or id, export }`);
  }
}
