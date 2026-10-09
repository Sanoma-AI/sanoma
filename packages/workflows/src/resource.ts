import { z } from "zod";
import { type OpSpec, RESOURCE } from "./op.ts";

/** Which fields of a resource are flagged, by dotted path (`pages.html_url`; a list's items have no index). */
export interface ResourceFields {
  /** Changing it replaces the object. */
  readonly immutable: readonly string[];
  /** Set by the vendor only: never drift. */
  readonly vendorOwned: readonly string[];
  /** Sensitive or write-only: never read back, never compared, never in an operation's output. */
  readonly writeOnly: readonly string[];
}

/** What an operation of a resource says beyond what `defineResource` derives. */
export interface CrudOptions {
  description?: string;
}

type State = Record<string, unknown>;

/** A resource type, as its connector declares it with `defineResource`. */
export interface ResourceSpec<S extends z.ZodObject = z.ZodObject> {
  /** The connector's vendor id, such as `github`. */
  vendor: string;
  /** The type's name within the vendor, such as `repository`: its operations are `<vendor>.<type>.read` and `.import`. */
  type: string;
  /** What people call it, such as "Repository". */
  title: string;
  /** How `find` makes the import id, for people: `name`, `repository_id:pattern`. */
  identity: string;
  /** The resource's fields as a data file declares them and a read returns them. */
  schema: S;
  fields: ResourceFields;
  /** The vendor's id for a declared resource (the import id), from its declared fields. */
  find: (desired: z.input<S>) => string;
  /**
   * The part of a state that a drift check compares, given what was declared. The check
   * compares `normalize(actual, desired)` with `normalize(desired, desired)`. Default:
   * `compareDeclared`, which keeps the declared fields only.
   */
  normalize?: (state: State, desired: z.input<S>) => State;
  /** The operations the type has. Phase 5 reads only; create, update and delete join them when it writes. */
  crud: { read: CrudOptions; import: CrudOptions };
}

/** A resource a data file declares: `github.repository({ name: "sanoma" })`. Plain data, so a reader can parse it. */
export interface Declared<T = State> {
  readonly kind: "resource";
  readonly vendor: string;
  readonly type: string;
  /** The vendor's id for it: what `find` made of `desired`. */
  readonly name: string;
  readonly desired: T;
}

const importId = z.string().min(1);
/** What a bridged resource's provider keeps beside its state; passed back on the next read. */
const handle = {
  private: z.string().optional().describe("The provider's private data for the object, base64; pass it back unchanged"),
  schemaVersion: z.number().int().nonnegative().optional().describe("The version of the state's layout"),
};

const opsOf = <S extends z.ZodObject>(schema: S) => ({
  import: { input: z.object({ id: importId }), output: z.object({ id: importId, state: schema, ...handle }) },
  read: {
    input: z.object({ id: importId, state: z.record(z.string(), z.unknown()).optional(), ...handle }),
    output: z.object({ id: importId, gone: z.boolean(), state: schema.optional(), ...handle }),
  },
});

/** The policy's `target` for a resource's operations: the import id. */
const target = ({ id }: { id: string }) => id;

type OpsOf<S extends z.ZodObject> = ReturnType<typeof opsOf<S>>;

/** A resource type's operation specs, for `defineConnector`: `{ repository: repository.ops }`. */
export type ResourceOps<S extends z.ZodObject> = {
  [N in keyof OpsOf<S>]: OpSpec<OpsOf<S>[N]["input"], OpsOf<S>[N]["output"]>;
};

/**
 * A resource type: call it to declare a resource in a data file, and give its `ops` to
 * `defineConnector`.
 */
export interface Resource<S extends z.ZodObject = z.ZodObject> {
  (desired: z.input<S>): Declared<z.input<S>>;
  readonly vendor: string;
  readonly type: string;
  readonly title: string;
  readonly identity: string;
  readonly schema: S;
  readonly fields: ResourceFields;
  readonly find: (desired: z.input<S>) => string;
  readonly normalize: (state: State, desired: z.input<S>) => State;
  /** `read` and `import`, each effect `read`, idempotent, with the import id as `target`. */
  readonly ops: ResourceOps<S>;
}

const isObject = (v: unknown): v is State => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The fields of `state` that `desired` declares, minus vendor-owned and write-only ones: only
 * declared fields are compared, as CloudFormation does. An object is picked field by field, a
 * list item by item against the declared item at its index; anything else is kept whole.
 *
 * So a field the data file leaves out is never drift, whatever the vendor holds. That covers
 * attributes the provider marks `computed` and `optional`: they are the user's to set, not
 * vendor-owned, but the vendor fills them when nobody does (GitHub's `etag`, `topics`,
 * `visibility`), so they are compared only when declared.
 */
export function compareDeclared(fields: ResourceFields, state: State, desired: State): State {
  const skip = new Set([...fields.vendorOwned, ...fields.writeOnly]);
  const pick = (actual: unknown, declared: unknown, prefix: string): unknown => {
    if (Array.isArray(declared) && Array.isArray(actual)) {
      return actual.map((item, i) => (i < declared.length ? pick(item, declared[i], prefix) : item));
    }
    if (!isObject(declared) || !isObject(actual)) return actual ?? null;
    const out: State = {};
    for (const [name, value] of Object.entries(declared)) {
      if (value === undefined || skip.has(prefix + name)) continue;
      out[name] = pick(actual[name], value, `${prefix + name}.`);
    }
    return out;
  };
  return pick(state, desired, "") as State;
}

/**
 * Declares a resource type: its schema, flagged fields, identity and how it is compared, and
 * derives its operations, `<vendor>.<type>.read` and `<vendor>.<type>.import`, both effect
 * `read` and idempotent, with the import id as the policy's `target`:
 *
 * - `import` takes `{ id }`, the import id, and returns the object's `state` (with the
 *   provider's `private` data and `schemaVersion` when it is bridged), or fails when there is
 *   no such object.
 * - `read` takes `{ id, state?, private?, schemaVersion? }`, a state from an earlier `import`
 *   or `read`, and returns `{ gone: true }` when the object no longer exists, else its fresh
 *   `state`. A driver may import first when it is given no state.
 *
 * Calling the result declares one resource, for a data file:
 * `repository({ name: "sanoma" })` is `{ kind: "resource", vendor, type, name: "sanoma", desired }`.
 * It refuses fields the schema does not have, values it rejects, and an empty identity.
 */
export function defineResource<S extends z.ZodObject>(spec: ResourceSpec<S>): Resource<S> {
  const { vendor, type, schema, find } = spec;
  const what = `${vendor}.${type}`;
  const io = opsOf(schema);
  const ops = {
    import: {
      effect: "read",
      idempotent: true,
      description:
        spec.crud.import.description ?? `Find a ${spec.title.toLowerCase()} by its ${spec.identity} and read it`,
      ...io.import,
      target,
    },
    read: {
      effect: "read",
      idempotent: true,
      description:
        spec.crud.read.description ?? `Read a ${spec.title.toLowerCase()} as it is now; gone when it no longer exists`,
      ...io.read,
      target,
    },
  } satisfies ResourceOps<S>;

  const declare = (desired: z.input<S>): Declared<z.input<S>> => {
    const unknown = Object.keys(desired ?? {}).filter((name) => !Object.hasOwn(schema.shape, name));
    if (unknown.length) throw new Error(`${what}: no field ${unknown.join(", ")}`);
    const parsed = schema.safeParse(desired);
    if (!parsed.success) throw new Error(`${what}: ${z.prettifyError(parsed.error)}`);
    const name = find(desired);
    if (typeof name !== "string" || name === "") throw new Error(`${what}: its ${spec.identity} is missing`);
    return Object.freeze({ kind: "resource", vendor, type, name, desired });
  };
  const resource = Object.assign(declare, {
    vendor,
    type,
    title: spec.title,
    identity: spec.identity,
    schema,
    fields: spec.fields,
    find,
    normalize: spec.normalize ?? ((state: State, desired: z.input<S>) => compareDeclared(spec.fields, state, desired)),
    ops,
  });
  // The connector keeps the type beside its operations (see `RESOURCE`), for `describeConfig`.
  Object.defineProperty(ops, RESOURCE, { value: resource });
  return Object.freeze(resource);
}

/** The resource type a connector's resource group is for, when `defineResource` made its operations. */
export const resourceOf = (group: unknown): Resource | undefined =>
  (group as { [RESOURCE]?: Resource } | undefined)?.[RESOURCE];
