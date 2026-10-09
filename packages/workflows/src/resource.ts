import { z } from "zod";
import { type OpSpec, RESOURCE } from "./op.ts";

/** Which fields of a resource are flagged, by dotted path (`pages.html_url`; a list's items have no index). */
export interface ResourceFields {
  /** Changing it replaces the object. */
  readonly immutable: readonly string[];
  /** Set by the vendor only: never drift, and a data file may not declare it. */
  readonly vendorOwned: readonly string[];
  /** Sensitive or write-only: never read back, never compared, never in an operation's output. */
  readonly writeOnly: readonly string[];
  /** Lists whose order is the vendor's (a set): compared as multisets, in no order. */
  readonly unordered?: readonly string[];
}

type State = Record<string, unknown>;

/** A resource type, as its connector declares it with `defineResource`. */
export interface ResourceSpec<S extends z.ZodObject = z.ZodObject> {
  /** The connector's vendor id, such as `github`; `defineConnector` refuses a type of another vendor. */
  vendor: string;
  /** The type's name within the vendor, such as `repository`: its operations are `<vendor>.<type>.read` and `.import`. */
  type: string;
  /** What people call it, such as "Repository". */
  title: string;
  /**
   * How `find` makes the import id, for people: `name`, `repository_id:pattern`. The fields it
   * names stay declarable even when the vendor sets them (Stripe's `id`).
   */
  identity: string;
  /** The resource's fields as a read returns them; a data file declares them, less the vendor-owned ones. */
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

/**
 * What a data file may give a resource type: its fields, where a string field may name another
 * declared resource instead (`repository_id: site`), which stands for that resource's `name`.
 */
export type Declarable<T> = { [K in keyof T]: string extends T[K] ? T[K] | Declared : T[K] };

const importId = z.string().min(1);
/** What a driver keeps beside a state (an OpenTofu provider's private data and state version), passed back unchanged. */
const handle = z.string().optional().describe("The driver's data for the object, opaque: pass it back unchanged");

const opsOf = <S extends z.ZodObject>(schema: S) => ({
  import: { input: z.object({ id: importId }), output: z.object({ id: importId, state: schema, handle }) },
  read: {
    input: z.object({ id: importId, state: z.record(z.string(), z.unknown()).optional(), handle }),
    output: z.object({ id: importId, gone: z.boolean(), state: schema.optional(), handle }),
  },
});

/** The policy's `target` for a resource's operations: the import id. */
const target = ({ id }: { id: string }) => id;

type OpsOf<S extends z.ZodObject> = ReturnType<typeof opsOf<S>>;

/** A resource type's operation specs: `read` and `import`. */
export type ResourceOps<S extends z.ZodObject> = {
  [N in keyof OpsOf<S>]: OpSpec<OpsOf<S>[N]["input"], OpsOf<S>[N]["output"]>;
};

/**
 * A resource type: call it to declare a resource in a data file, and give it to
 * `defineConnector` as a group, under its `type`: `defineConnector("github", { repository })`.
 */
export interface Resource<S extends z.ZodObject = z.ZodObject> extends Readonly<Required<ResourceSpec<S>>> {
  (desired: Declarable<z.input<S>>): Declared<Declarable<z.input<S>>>;
  /** `read` and `import`, each effect `read`, idempotent, with the import id as `target`. */
  readonly ops: ResourceOps<S>;
  readonly [RESOURCE]: true;
}

const isObject = (v: unknown): v is State => typeof v === "object" && v !== null && !Array.isArray(v);

const isDeclared = (v: unknown): v is Declared =>
  isObject(v) && v.kind === "resource" && typeof v.name === "string" && typeof v.type === "string";

/** `value` with each declared resource in it replaced by its `name`, the import id it stands for. */
function withNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withNames);
  if (isDeclared(value)) return value.name;
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([field, v]) => [field, withNames(v)]));
}

/** One order for a list compared as a multiset: by each item's JSON. */
const canonical = (items: unknown[]) =>
  items
    .map((item) => [JSON.stringify(item) ?? "", item] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);

const comparers = new WeakMap<ResourceFields, (state: State, desired: State) => State>();

/**
 * The fields of `state` that `desired` declares, minus vendor-owned and write-only ones: only
 * declared fields are compared, as CloudFormation does. An object is picked field by field, a
 * list item by item against the declared item at its index, and an `unordered` list (a set)
 * item by item against what its declared items declare, then sorted, so its order never
 * drifts. Anything else is kept whole.
 *
 * So a field the data file leaves out is never drift, whatever the vendor holds. That covers
 * attributes the provider marks `computed` and `optional`: they are the user's to set, not
 * vendor-owned, but the vendor fills them when nobody does (GitHub's `etag`, `topics`,
 * `visibility`), so they are compared only when declared.
 */
export function compareDeclared(fields: ResourceFields, state: State, desired: State): State {
  let compare = comparers.get(fields);
  if (!compare) {
    compare = comparer(fields);
    comparers.set(fields, compare);
  }
  return compare(state, desired);
}

function comparer(fields: ResourceFields) {
  const skip = new Set([...fields.vendorOwned, ...fields.writeOnly]);
  const unordered = new Set(fields.unordered);
  const pick = (actual: unknown, declared: unknown, path: string): unknown => {
    if (Array.isArray(declared) && Array.isArray(actual)) {
      if (unordered.has(path)) {
        // What any declared item declares: a set's items have no declared counterpart by index.
        const objects = declared.filter(isObject);
        const like = objects.length ? Object.assign({}, ...objects) : undefined;
        return canonical(like ? actual.map((item) => pick(item, like, path)) : actual);
      }
      return actual.map((item, i) => (i < declared.length ? pick(item, declared[i], path) : item));
    }
    if (!isObject(declared) || !isObject(actual)) return actual ?? null;
    const out: State = {};
    for (const [name, value] of Object.entries(declared)) {
      const at = path ? `${path}.${name}` : name;
      if (value === undefined || skip.has(at)) continue;
      out[name] = pick(actual[name], value, at);
    }
    return out;
  };
  return (state: State, desired: State) => pick(state, desired, "") as State;
}

/** The dotted paths in `value` that `paths` holds, looking into objects and lists' items. */
function pathsIn(value: unknown, paths: ReadonlySet<string>, prefix = ""): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => pathsIn(item, paths, prefix)))];
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([name, v]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    if (v === undefined) return [];
    return paths.has(path) ? [path] : pathsIn(v, paths, path);
  });
}

/**
 * Declares a resource type: its schema, flagged fields, identity and how it is compared, and
 * derives its operations, `<vendor>.<type>.read` and `<vendor>.<type>.import`, both effect
 * `read` and idempotent, with the import id as the policy's `target`:
 *
 * - `import` takes `{ id }`, the import id, and returns the object's `state` (with the
 *   driver's opaque `handle` when it keeps one), or fails when there is no such object.
 * - `read` takes `{ id, state?, handle? }`, a state from an earlier `import` or `read`, and
 *   returns `{ gone: true }` when the object no longer exists, else its fresh `state`. A
 *   driver may import first when it is given no state.
 *
 * Calling the result declares one resource, for a data file:
 * `repository({ name: "sanoma" })` is `{ kind: "resource", vendor, type, name: "sanoma", desired }`.
 * It refuses fields the schema does not have, fields the vendor owns (unless the identity names
 * them), values the schema rejects, and an empty identity. A field may name another declared
 * resource (`repository_id: site`): it is checked, and `find` reads it, as that resource's
 * `name`, and `desired` keeps the resource itself.
 */
export function defineResource<S extends z.ZodObject>(spec: ResourceSpec<S>): Resource<S> {
  const { vendor, type, schema, fields, find } = spec;
  const what = `${vendor}.${type}`;
  const io = opsOf(schema);
  const ops = {
    import: {
      effect: "read",
      idempotent: true,
      description: `Find a ${spec.title.toLowerCase()} by its ${spec.identity} and read it`,
      ...io.import,
      target,
    },
    read: {
      effect: "read",
      idempotent: true,
      description: `Read a ${spec.title.toLowerCase()} as it is now; gone when it no longer exists`,
      ...io.read,
      target,
    },
  } satisfies ResourceOps<S>;

  const named = new Set(spec.identity.match(/[A-Za-z_][\w.]*/g));
  const owned = new Set(fields.vendorOwned.filter((path) => !named.has(path)));
  const declare = (given: Declarable<z.input<S>>): Declared<Declarable<z.input<S>>> => {
    const desired = withNames(given) as z.input<S>;
    const unknown = Object.keys(desired ?? {}).filter((name) => !Object.hasOwn(schema.shape, name));
    if (unknown.length) throw new Error(`${what}: no field ${unknown.join(", ")}`);
    const vendors = pathsIn(desired, owned);
    if (vendors.length) {
      throw new Error(
        `${what}: leave out ${vendors.join(", ")}: the vendor sets ${vendors.length > 1 ? "them" : "it"}`,
      );
    }
    const parsed = schema.safeParse(desired);
    if (!parsed.success) throw new Error(`${what}: ${z.prettifyError(parsed.error)}`);
    const name = find(desired);
    if (typeof name !== "string" || name === "") throw new Error(`${what}: its ${spec.identity} is missing`);
    return Object.freeze({ kind: "resource", vendor, type, name, desired: given });
  };
  const resource = Object.assign(declare, {
    vendor,
    type,
    title: spec.title,
    identity: spec.identity,
    schema,
    fields,
    find,
    normalize: spec.normalize ?? ((state: State, desired: z.input<S>) => compareDeclared(fields, state, desired)),
    ops,
  });
  // A symbol, so `defineConnector` tells a resource type from a group of operations.
  Object.defineProperty(resource, RESOURCE, { value: true });
  return Object.freeze(resource) as Resource<S>;
}
