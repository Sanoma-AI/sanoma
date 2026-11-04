import type { ConnectionRef } from "./connection.ts";
import { z } from "zod";
import { checkDatabase, type DatabaseSpec } from "./database.ts";
import { isRunControlError } from "./errors.ts";
import { checkHost, hasPath, type HostSpec } from "./host.ts";
import { type Connector, type OpSpec, RESOURCE, VENDOR } from "./op.ts";
import { isSanomaSecret, isSecret, type Secret } from "./secret.ts";
import { errorMessage } from "./shared.ts";
import { checkWakeup, type WakeupSpec } from "./wakeup.ts";

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
  /**
   * Fields that name another declared resource, by dotted path: the `<vendor>.<type>` it is, and
   * how the vendor spells it (`by`): `{ repository_id: { type: "github.repository", by: ["name",
   * "node_id"] } }`. A data file gives that resource there (`repository_id: site`), which stands
   * for its `name`; anywhere else a resource is refused.
   */
  readonly references?: References;
}

/** Where a field names another declared resource: see `ResourceFields.references`. */
export interface FieldReference {
  /** The `<vendor>.<type>` of the resource it names, or the types it may name one of. */
  readonly type: string | readonly string[];
  /**
   * The fields of that resource's state the vendor may hold here instead of its `name`, such as
   * GitHub's `node_id`: a drift check takes any of their values, read in the same run, as the
   * declared one. Without it, the field holds the resource's `name`, and is compared as it is.
   */
  readonly by?: readonly string[];
  /**
   * A dotted path in that resource's state: apply and drift give this field the named resource's
   * state at this path, as a whole (a list or an object), read in the same run or made by an
   * earlier step of it (`records: mail` takes a `resend.domain`'s `dns_records`). A data file may
   * give a literal value here instead. `desired` holds the resource's `name` until then, which the
   * schema does not judge. Where the same apply changes that resource at the path (creates or
   * replaces it, or updates it with the path `unknown` or another value there in its plan), or,
   * for a create, it has no state yet or nothing at the path, a plan is given `null` there (known
   * after apply: the type's `plan` must accept it and report the path in `unknown`), so a change it
   * makes is planned, and approved, up front. A plan of a bound object leaves the field out while
   * its resource is absent, gone or unreadable and not about to change, as drift does, and its step
   * runs without it. A step given `null` for the field whose value is still not known (its
   * resource's step failed or did not run) fails before its driver is called, and drift leaves the
   * field out. An empty list or object at the path counts as known: a vendor that answers `[]`
   * while it is still filling the list makes the dependent write an empty one. The path must be a
   * field of each type it may name (`checkFromRefs`, when a config is resolved). Not on a
   * write-only field, nor one holding a write-only field (refused). Not yet on a bridge-backed type
   * (`tfConnector`): an OpenTofu provider's plan reads `null` as unset, not as known after apply.
   */
  readonly from?: string;
}

/** A resource type's `fields.references`: by dotted path, the resource each names. */
export type References = { readonly [path: string]: FieldReference };

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
   * names stay declarable even when the vendor sets them. Absent with `find`: a type the vendor
   * names alone (Stripe's) is found only by its binding.
   */
  identity?: string;
  /** The resource's fields as a read returns them; a data file declares them, less the vendor-owned ones. */
  schema: S;
  fields: ResourceFields;
  /**
   * The import id that finds a declared resource before it is bound, from its declared fields:
   * its identity. Absent when its fields cannot name it.
   */
  find?: (desired: z.input<S>) => string;
  /**
   * The id a binding keeps for an object, from its state: stable for the object's life (GitHub's
   * `node_id`, not its name), and one `import` accepts. Default: `String(state.id)`.
   */
  bindingId?: (state: State) => string;
  /**
   * The part of a state that a drift check compares, given what was declared. The check
   * compares `normalize(actual, desired)` with `normalize(desired, desired)`. Default:
   * `compareDeclared`, which keeps the declared fields only.
   */
  normalize?: (state: State, desired: z.input<S>) => State;
  /**
   * True when apply may change its objects: the type then has the change operations `plan`,
   * `create`, `update` and `delete` besides `read` and `import`. Default false.
   */
  writable?: boolean;
  /** Set when the type meets the `Host` contract: it runs the company. Such a type is `writable` and `stateless`. */
  host?: HostSpec;
  /**
   * Set when the type meets the `Wakeup` contract: it wakes a stopped instance at a time. Such a
   * type is `writable`, and its connector has the operation `register` names.
   */
  wakeup?: WakeupSpec;
  /**
   * Set when the type meets the `Database` contract: it holds the company's database. Such a type
   * is `writable`, not `stateless`, and its `afterCreate` calls the operation `storeUrl` names.
   */
  database?: DatabaseSpec;
  /**
   * True when its objects hold no data, so one gone at the vendor is created again by apply
   * without asking (a host running the company's code); otherwise apply asks first, as a
   * recreated database looks fine and has lost its data. Default: true for a host, else false.
   */
  stateless?: boolean;
  /**
   * True when there is no vendor object behind a declaration: the repo is all there is of it (the
   * runtime's people, `sanoma.person`). Such a type has no operations, so no driver, and drift and
   * apply pass its resources by. Default false.
   */
  vendorless?: boolean;
  /**
   * Operations apply calls, in order, right after it creates one of its objects and binds it: a
   * Supabase project's health, until it is healthy, then its database URL stored.
   */
  afterCreate?: readonly AfterCreate[];
  /**
   * The ids (`<vendor>.<type>`) this type was known by before a rename: a lockfile binding under
   * one of them binds a declaration of this type to the same object, so a rename recreates nothing
   * (`cloudflare.host`, formerly `cloudflare.container`). Apply writes the new id with its next
   * change to that binding.
   */
  formerly?: readonly string[];
}

/** One operation apply calls after a create (`ResourceSpec.afterCreate`). */
export interface AfterCreate {
  /** The operation's id, among the config's: `supabase.database.storeUrl`. */
  op: string;
  /** Its input, from the new object's binding id and the data file's export that declares it. */
  input: (made: { id: string; export: string }) => unknown;
  /**
   * Called again, every few seconds, until its output passes this, for up to 10 minutes; a call
   * that fails meanwhile is one that did not pass, its output `undefined`.
   */
  until?: (output: any) => boolean;
}

/** How long apply waits between calls of an `afterCreate` operation with `until`, and how many calls it makes. */
export const AFTER_CREATE_SECONDS = 5;
export const AFTER_CREATE_CALLS = 120;
/** How long an `afterCreate` operation may be polled, in all, in milliseconds. */
export const AFTER_CREATE_MS = AFTER_CREATE_SECONDS * AFTER_CREATE_CALLS * 1000;

/** Why an `afterCreate` operation with `until` did not pass: the time it was given, and its last call's error if that failed. */
export const afterCreateStuck = (op: string, failed: unknown): string =>
  `${op} did not pass in ${AFTER_CREATE_MS / 60_000} minutes` +
  (failed === undefined ? "" : `; its last call failed: ${errorMessage(failed)}`);

/**
 * Calls one `afterCreate` operation for a new object as apply does: with `until`, again every
 * few seconds until its output passes, a call that fails meanwhile being one that did not pass;
 * without, once, a failure thrown. Returns why it did not pass, if it did not. Apply inlines the
 * same loop in its `run`, which may not close over its `ctx`; an operation's own test calls this.
 */
export async function callAfterCreate(
  hook: AfterCreate,
  made: { id: string; export: string },
  call: (op: string, input: unknown) => Promise<unknown>,
  sleep: (seconds: number) => Promise<void>,
): Promise<string | undefined> {
  const given = hook.input(made);
  let output: unknown;
  let failed: unknown;
  for (let n = 0; n < AFTER_CREATE_CALLS && (n === 0 || (hook.until && !hook.until(output))); n++) {
    if (n > 0) await sleep(AFTER_CREATE_SECONDS);
    try {
      output = await call(hook.op, given);
      failed = undefined;
    } catch (err) {
      if (isRunControlError(err) || !hook.until) throw err;
      output = undefined;
      failed = err;
    }
  }
  if (hook.until && !hook.until(output)) return afterCreateStuck(hook.op, failed);
  return undefined;
}

/**
 * Where a declared resource keeps its brand, its type's `<vendor>.<type>`: a symbol, so a field
 * holding a resource is told from data; a registered one (`Symbol.for`), so a copy of this
 * package reads what another copy declared, as `VENDOR`.
 */
export const DECLARED: unique symbol = Symbol.for("sanoma.declared");

/** A resource a data file declares: `github.repository({ owner: "acme", name: "sanoma" })`. */
export interface Declared<Id extends string = string, T = State> {
  readonly [DECLARED]: Id;
  readonly vendor: string;
  readonly type: string;
  /** Its identity, the import id that finds it unbound: what `find` made of `desired`; absent without `find`. */
  readonly name?: string;
  /**
   * Its fields, each resource it names replaced by that resource's `name`: what its type
   * checked, and what a drift check compares.
   */
  readonly desired: T;
  readonly connection?: ConnectionRef;
  /**
   * Where it names another resource: the field's dotted path (a list item's with its index,
   * `teams.0`) to that resource's `<vendor>.<type>:<name>`, or its `<vendor>.<type>` alone when it
   * has no identity (then `desired` holds nothing there until the loader puts the declaration's id).
   */
  readonly refs: Readonly<Record<string, string>>;
}

/**
 * What a resource type's constructor takes: its fields, where `R` (its `fields.references`)
 * names a path, a declared resource of that type instead of a value (`repository_id: site`), in
 * place of the whole field for a `from` reference (`records: mail`) and of each item for a list
 * otherwise, and where a string goes, a secret (`secret("NAME")`), which the constructor allows
 * at a write-only field only.
 */
export type Declaring<T, R extends References = {}> = [keyof R] extends [never]
  ? WithSecrets<T>
  : DeclaringAt<T, R, "">;

type WithSecrets<V> = V extends string
  ? V | Secret
  : V extends readonly (infer I)[]
    ? WithSecrets<I>[]
    : V extends object
      ? { [K in keyof V]: WithSecrets<V[K]> }
      : V;

type DeclaringAt<T, R extends References, P extends string> = T extends readonly (infer I)[]
  ? DeclaringAt<I, R, P>[]
  : T extends object
    ? { [K in keyof T]: K extends string ? DeclaringField<T[K], R, P extends "" ? K : `${P}.${K}`> : T[K] }
    : WithSecrets<T>;

type DeclaringField<V, R extends References, P extends string> = P extends keyof R
  ? R[P] extends { readonly from: string }
    ? WithSecrets<V> | DeclaredOf<R[P]["type"]>
    : V extends readonly (infer I)[]
      ? (WithSecrets<I> | DeclaredOf<R[P]["type"]>)[]
      : WithSecrets<V> | DeclaredOf<R[P]["type"]>
  : [Extract<keyof R, `${P}.${string}`>] extends [never]
    ? WithSecrets<V>
    : DeclaringAt<V, R, P>;

type DeclaredOf<Id> = Id extends string ? Declared<Id> : Id extends readonly (infer E)[] ? DeclaredOf<E> : never;

const importId = z.string().min(1);
/** What a driver keeps beside a state (an OpenTofu provider's private data and state version), passed back unchanged. */
const handle = z.string().optional().describe("The driver's data for the object, opaque: pass it back unchanged");

const record = z.record(z.string(), z.unknown());

/** What a plan of a change says will happen, as `PlanResponse.Action` names it. */
export const PLAN_ACTIONS = ["none", "create", "update", "replace", "delete"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** The operations of a writable type that change its objects (`isChangeOp`): apply's for a declared object, any workflow's for another. */
export const CHANGE_OPS = ["create", "update", "delete"] as const;

const opsOf = <S extends z.ZodObject>(schema: S) => {
  // Both answer `{ gone: true }` when the vendor has no such object, and its state when it has.
  const output = z.object({ id: importId, gone: z.boolean(), state: schema.optional(), handle });
  const known = { id: importId, state: record.optional(), handle };
  // The declared fields, a secret marker (`{ $secret }`) at a write-only one: the driver resolves it.
  const desired = record.describe("The declared fields; a write-only one may hold a secret marker");
  const changed = z.object({ id: importId, state: schema, handle });
  const action = z.enum(PLAN_ACTIONS);
  /** Fields as dotted paths, a list item's with its index. */
  const paths = z.array(z.string());
  return {
    import: { input: z.object({ id: importId }), output },
    read: { input: z.object(known), output },
    plan: {
      input: z.object({ ...known, id: importId.optional(), desired: desired.optional() }),
      output: z.object({
        action,
        // The new state, without write-only fields; a value known only after apply is `null`, its path in `unknown`.
        planned: record.optional(),
        unknown: paths,
        replace: paths.describe("The fields whose change replaces the object: not empty exactly when `replace`"),
      }),
    },
    create: { input: z.object({ desired }), output: changed },
    update: {
      input: z.object({ ...known, desired, expect: z.object({ action, replace: paths }).optional() }),
      output: changed,
    },
    delete: { input: z.object(known), output: z.object({ id: importId, gone: z.literal(true) }) },
  };
};

/** What the ledger keeps of a resource operation's `handle`: its name, never its bytes. */
const opaque = ["handle"] as const;

/** The policy's `target` for a resource's operations: the id, an identity or a binding id. */
const target = ({ id }: { id: string }) => id;

type OpsOf<S extends z.ZodObject> = ReturnType<typeof opsOf<S>>;
type Specs<S extends z.ZodObject, N extends keyof OpsOf<S>> = {
  [K in N]: OpSpec<OpsOf<S>[K]["input"], OpsOf<S>[K]["output"]>;
};

/**
 * A resource type's operation specs: `read` and `import`, and for a writable type (`W`) the
 * change operations `plan`, `create`, `update` and `delete`.
 */
export type ResourceOps<S extends z.ZodObject, W extends boolean = false> = Specs<S, "read" | "import"> &
  ([W] extends [true] ? Specs<S, "plan" | (typeof CHANGE_OPS)[number]> : {});

/**
 * True for an operation that changes a writable type's objects (`CHANGE_OPS`), which only the
 * apply workflow may call on a declared object (a workflow's call is refused one, `refuseDeclared`
 * in `call.ts`): by its vendor, resource and name, so a copy of a connector is told too.
 */
export function isChangeOp(
  op: { readonly vendor: string; readonly resource: string; readonly name: string },
  types: ReadonlyMap<string, Pick<Resource, "writable">>,
): boolean {
  return (
    (CHANGE_OPS as readonly string[]).includes(op.name) && types.get(`${op.vendor}.${op.resource}`)?.writable === true
  );
}

/**
 * True for an operation of a declared resource type (`read`, `import`, and a writable type's
 * `plan` and change operations), which only drift and apply call: by its vendor and resource.
 */
export const isResourceOp = (
  op: { readonly vendor: string; readonly resource: string },
  types: ReadonlyMap<string, unknown>,
): boolean => types.has(`${op.vendor}.${op.resource}`);

/**
 * A resource type: call it to declare a resource in a data file, and give it to
 * `defineConnector` as a group, under its `type`: `defineConnector("github", { repository })`.
 */
export interface Resource<
  S extends z.ZodObject = z.ZodObject,
  Id extends string = string,
  R extends References = {},
  W extends boolean = boolean,
>
  extends
    Readonly<
      Required<
        Omit<
          ResourceSpec<S>,
          | "identity"
          | "find"
          | "writable"
          | "host"
          | "wakeup"
          | "database"
          | "stateless"
          | "afterCreate"
          | "vendorless"
          | "formerly"
        >
      >
    >,
    Readonly<Pick<ResourceSpec<S>, "identity" | "find" | "host" | "wakeup" | "database" | "afterCreate" | "formerly">> {
  (
    desired: Declaring<z.input<S>, R>,
    options?: { connection?: ConnectionRef<Id extends `${infer V}.${string}` ? V : string> },
  ): Declared<Id, z.input<S>>;
  /** `read` and `import`, each effect `read`, idempotent, with the id as `target`; for a writable type, the change operations too. */
  readonly ops: ResourceOps<S, W>;
  /** True when apply may change its objects: it has the change operations. */
  readonly writable: W;
  /** True when apply may recreate or replace its objects as routine: they keep no data. */
  readonly stateless: boolean;
  /** True when there is no vendor object behind it (`ResourceSpec.vendorless`): it has no operations. */
  readonly vendorless: boolean;
  readonly [RESOURCE]: true;
}

/** True for a plain object: not null, not a list. */
export const isObject = (v: unknown): v is State => typeof v === "object" && v !== null && !Array.isArray(v);

/** `path.name`, or `name` at the top: a field's dotted path. */
export const joinPath = (path: string, name: string) => (path ? `${path}.${name}` : name);

/** A declared resource: what a constructor returns, made by any copy of this package. */
export const isDeclared = (v: unknown): v is Declared =>
  isObject(v) && typeof (v as Partial<Declared>)[DECLARED] === "string";

/** One order for a list compared as a multiset: by each item's JSON. */
const canonical = (items: unknown[]) =>
  items
    .map((item) => [JSON.stringify(item) ?? "", item] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);

interface Comparer {
  pick: (state: State, desired: State) => State;
  /** `fields.unordered`, as a set. */
  unordered: ReadonlySet<string>;
}

const comparers = new WeakMap<ResourceFields, Comparer>();

/** The type's comparer, made once per `fields`. */
function comparerOf(fields: ResourceFields): Comparer {
  let compare = comparers.get(fields);
  if (!compare) {
    compare = comparer(fields);
    comparers.set(fields, compare);
  }
  return compare;
}

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
  return comparerOf(fields).pick(state, desired);
}

function comparer(fields: ResourceFields): Comparer {
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
      const at = joinPath(path, name);
      if (value === undefined || skip.has(at)) continue;
      out[name] = pick(actual[name], value, at);
    }
    return out;
  };
  return { pick: (state, desired) => pick(state, desired, "") as State, unordered };
}

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
 * Where `state` differs from what `desired` declares: the type's `normalize` of each (by default
 * `compareDeclared`: declared fields only, never vendor-owned or write-only ones, `unordered`
 * lists as sets), then leaf by leaf: objects field by field, lists of one length item by item,
 * and anything else (a list whose length changed, an `unordered` one) whole.
 *
 * `accept` is, by a reference's path as `refs` has it (`repository_id`, `teams.0`), the values
 * the vendor may hold there for the resource it names (its `node_id`, say: see
 * `FieldReference.by`): any of them counts as the declared value.
 */
export function diffDeclared(
  // `any`: a type's `normalize` takes its own declared fields.
  resource: { readonly fields: ResourceFields; readonly normalize: (state: State, desired: any) => State },
  state: State,
  desired: State,
  accept: Readonly<Record<string, readonly unknown[]>> = {},
): DriftField[] {
  const actual = withAccepted(state, desired, accept);
  const { unordered } = comparerOf(resource.fields);
  return changes(resource.normalize(desired, desired), resource.normalize(actual, desired), unordered);
}

/** `state`, with each value `accept` takes at its path replaced by the declared one there. */
function withAccepted(state: State, desired: State, accept: Readonly<Record<string, readonly unknown[]>>): State {
  const paths = Object.entries(accept).filter(([, values]) => values.length);
  if (!paths.length) return state;
  const out = structuredClone(state);
  for (const [path, values] of paths) {
    const at = holderOf(out, path);
    if (at && values.includes(at.holder[at.key])) at.holder[at.key] = valueAt(desired, path);
  }
  return out;
}

/** The object or list holding the value at a dotted path (a list item's by its index), and its key there. */
export function holderOf(value: unknown, path: string): { holder: State; key: string } | undefined {
  const keys = path.split(".");
  const key = keys.pop()!;
  const holder = keys.reduce<unknown>((v, k) => (isObject(v) || Array.isArray(v) ? (v as State)[k] : undefined), value);
  return isObject(holder) || Array.isArray(holder) ? { holder: holder as State, key } : undefined;
}

/**
 * Each place `refs` (a declaration's, by dotted path to the resource named there) holds a `from`
 * reference (`FieldReference.from`): its path, the resource it names (`named`), and the path in
 * that resource's state its value comes from.
 */
const fromRefs = (references: References | undefined, refs: Readonly<Record<string, string>>) =>
  Object.entries(refs).flatMap(([at, named]) => {
    const from = references?.[fieldPathOf(at)]?.from;
    return from === undefined ? [] : [{ at, named, from }];
  });

/** What `withFrom` makes of a `from` field it cannot fill: `null` (known after apply), or nothing. */
export type Missing = "unknown" | "drop";

/** A `from` reference `withFrom` could not fill: the resource it names has no state, or nothing at its path. */
export interface Unfilled {
  at: string;
  named: string;
  from: string;
  /** True when the resource has a state, with nothing at the path. */
  stated: boolean;
}

/**
 * `desired` with each field a `from` reference names given the state of the resource it names
 * at that path (a copy), `stateOf` that resource (by what `refs` holds there, and the path read);
 * and the references it could not fill, where that resource has no state or nothing there, each
 * such field `null` (`unknown`, a value known after apply) or left out (`drop`), as `missing` says
 * (for each reference, given a function). A reference with no place in `desired` to fill is
 * unfilled too. `desired` itself when there is no such field.
 */
export function withFrom(
  references: References | undefined,
  desired: State,
  refs: Readonly<Record<string, string>>,
  stateOf: (named: string, from: string) => State | undefined,
  missing: Missing | ((named: string, from: string) => Missing),
): { desired: State; unfilled: Unfilled[] } {
  const taken = fromRefs(references, refs);
  if (!taken.length) return { desired, unfilled: [] };
  const out = structuredClone(desired);
  const unfilled: Unfilled[] = [];
  for (const { at, named, from } of taken) {
    const place = holderOf(out, at);
    const state = stateOf(named, from);
    const value = state === undefined ? undefined : valueAt(state, from);
    if (place && value != null) {
      // A copy: what a driver is given never shares an object with the resource's state.
      place.holder[place.key] = structuredClone(value);
      continue;
    }
    unfilled.push({ at, named, from, stated: state !== undefined });
    if (!place) continue;
    if ((typeof missing === "function" ? missing(named, from) : missing) === "drop") delete place.holder[place.key];
    else place.holder[place.key] = null;
  }
  return { desired: out, unfilled };
}

/** A field's dotted path as `fields` names it, without a list item's index: `teams.0` is `teams`. */
export const fieldPathOf = (at: string) => at.replaceAll(/\.\d+(?=\.|$)/g, "");

/** The value at a dotted path, a list item's by its index. */
export const valueAt = (value: unknown, path: string) =>
  path.split(".").reduce<unknown>((v, key) => (isObject(v) || Array.isArray(v) ? (v as State)[key] : undefined), value);

/** True when the two are the same JSON, where a missing value is `null`. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (isObject(a) && isObject(b)) return Object.keys({ ...a, ...b }).every((key) => same(a[key], b[key]));
  return false;
}

/**
 * Where `actual` differs from `desired`, leaf by leaf. `path` names the field as `fields` does,
 * without indexes; `at` as a report does, with them.
 */
function changes(desired: unknown, actual: unknown, unordered: ReadonlySet<string>, path = "", at = ""): DriftField[] {
  if (isObject(desired) && isObject(actual)) {
    return Object.keys({ ...desired, ...actual }).flatMap((key) =>
      changes(desired[key], actual[key], unordered, joinPath(path, key), joinPath(at, key)),
    );
  }
  if (Array.isArray(desired) && Array.isArray(actual) && desired.length === actual.length && !unordered.has(path)) {
    return desired.flatMap((item, i) => changes(item, actual[i], unordered, path, joinPath(at, String(i))));
  }
  return same(desired, actual) ? [] : [{ path: at, desired: desired ?? null, actual: actual ?? null }];
}

/** The secret markers in a write-only value, in its place: the value itself, or a map of them (none: `[]`). */
function markers(value: unknown): unknown[] {
  if (isSecret(value)) return [value];
  if (!isObject(value)) return [];
  const kept = Object.entries(value).flatMap(([name, v]) => markers(v).map((m) => [name, m] as const));
  return kept.length ? [Object.fromEntries(kept)] : [];
}

/**
 * `desired` without the values at the fields the type marks write-only (a webhook's `secret`):
 * what a run may record of a declaration. A list's items lose them too. A secret marker
 * (`secret("NAME")`) stays, there or inside a write-only map (a host's `secrets`): it names a
 * stored secret and holds none, and the driver resolves it.
 */
export function withoutWriteOnly(fields: ResourceFields, desired: State): State {
  if (!fields.writeOnly.length) return desired;
  const drop = new Set(fields.writeOnly);
  const strip = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => strip(item, path));
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, v]) => {
        const at = joinPath(path, name);
        return drop.has(at) ? markers(v).map((m) => [name, m]) : [[name, strip(v, at)]];
      }),
    );
  };
  return strip(desired, "") as State;
}

/** True when `path` is one of `paths`, or a field inside one: a secret's map (`secrets.KEY`) is as write-only as the map. */
const underAny = (path: string, paths: ReadonlySet<string>) =>
  path.split(".").some((_, i, keys) => paths.has(keys.slice(0, i + 1).join(".")));

/** The dotted paths in `value` that `paths` holds, looking into objects and lists' items. */
function pathsIn(value: unknown, paths: ReadonlySet<string>, prefix = ""): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => pathsIn(item, paths, prefix)))];
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([name, v]) => {
    const path = joinPath(prefix, name);
    if (v === undefined) return [];
    return paths.has(path) ? [path] : pathsIn(v, paths, path);
  });
}

/**
 * Declares a resource type: its schema, flagged fields, identity and how it is compared, and
 * derives its operations, `<vendor>.<type>.read` and `<vendor>.<type>.import`, both effect
 * `read` and idempotent, with the import id as the policy's `target`:
 *
 * - `import` takes `{ id }`, an identity (what `find` makes) or a binding id (what `bindingId`
 *   makes), and returns `{ gone: false, state }`, the object's
 *   state (with the driver's opaque `handle` when it keeps one), or `{ gone: true }` when the
 *   vendor has no such object.
 * - `read` takes `{ id, state?, handle? }`, a state from an earlier `import` or `read`, and
 *   returns the same: `{ gone: true }` when the object no longer exists, else its fresh
 *   `state`. A driver may import first when it is given no state.
 *
 * A `writable` type has the change operations too, which only the apply workflow may call on a
 * declared object, and any workflow on another (`isChangeOp`): `create`, `update` and `delete`
 * effect `write` (`delete` idempotent), and `plan`:
 *
 * - `plan` (`read`, idempotent) takes `{ id?, state?, handle?, desired? }`, no `desired` for a
 *   delete and no `id` for a create, and returns `{ action, planned?, unknown, replace }`:
 *   what apply would do, the new state without write-only fields, the paths known only after
 *   apply, and those whose change replaces the object.
 * - `create` (`target` `new:<vendor>.<type>`) takes `{ desired }` and returns `{ id, state,
 *   handle? }`, `id` its binding id.
 * - `update` takes `{ id, state?, handle?, desired, expect? }` and returns the same; given
 *   `expect` (a plan's `action` and `replace`), it refuses a fresh plan that differs
 *   (`DriverError`, `vendorCode` `plan_changed`).
 *
 * A type whose fields take a `from` reference (`FieldReference.from`) is given `null` there by
 * apply's `plan` while the value is known only after apply, so its `plan` must accept `null` and
 * report the path in `unknown`; and its `update` must treat a field left out of `desired` as
 * keeping what the vendor holds, since a bound object whose `from` resource is gone is updated
 * with that field left out.
 * - `delete` takes `{ id, state?, handle? }` and returns `{ id, gone: true }`.
 *
 * `desired` may hold secret markers at write-only fields, which the driver resolves; no output
 * holds a write-only value.
 *
 * The ledger records a `handle` as `"<handle>"`, never its bytes (the operations' `opaque`).
 *
 * Calling the result declares one resource, for a data file: `repository({ owner: "acme", name: "sanoma" })`
 * is a `Declared`, `{ vendor, type, name: "acme/sanoma", desired, refs: {} }`. It refuses fields the
 * schema does not have, fields the vendor owns (unless the identity names them), values the
 * schema rejects, and an empty identity. Where `fields.references` allows it, a field may name
 * another declared resource of that type (`repository_id: site`): `desired` holds, and the
 * schema and `find` read, that resource's `name`, and `refs` says where it was named. A `from`
 * reference names one in place of the whole field, which apply and drift fill from its state, so
 * the schema does not judge the name there. A type without `find` declares resources without a
 * `name`, found only by their bindings.
 */
export function defineResource<
  S extends z.ZodObject,
  const V extends string,
  const T extends string,
  const R extends References = {},
  const W extends boolean = false,
>(
  spec: ResourceSpec<S> & { vendor: V; type: T; fields: { references?: R }; writable?: W },
): Resource<S, `${V}.${T}`, R, W> {
  const { vendor, type, schema, fields, find, identity, host, wakeup, database } = spec;
  const writable = (spec.writable ?? false) as W;
  const what: `${V}.${T}` = `${vendor}.${type}`;
  if (host) checkHost(what, host, spec);
  if (wakeup) checkWakeup(what, wakeup, spec);
  if (database) checkDatabase(what, database, spec);
  if (spec.vendorless && (writable || host))
    throw new Error(`${what}: a vendorless type has no object to change or host`);
  const title = spec.title.toLowerCase();
  const io = opsOf(schema);
  // The policy's `target` for a create: the type, as no object has an id yet.
  const created = `new:${what}`;
  const changeOps = {
    plan: {
      effect: "read",
      idempotent: true,
      description: `Plan how apply would make a ${title} match its declaration (or delete it, given none); nothing changes`,
      ...io.plan,
      target: ({ id }: { id?: string }) => id ?? created,
      opaque,
    },
    create: {
      effect: "write",
      description: `Create a ${title} as declared`,
      ...io.create,
      target: () => created,
      opaque,
    },
    update: {
      effect: "write",
      description: `Change a ${title} to match its declaration, replacing it where a field cannot change in place`,
      ...io.update,
      target,
      opaque,
    },
    delete: {
      effect: "write",
      // A retry reads first, and finds the object gone.
      idempotent: true,
      description: `Delete a ${title}; done already when it is gone`,
      ...io.delete,
      target,
      opaque,
    },
  } satisfies Specs<S, "plan" | (typeof CHANGE_OPS)[number]>;
  const base = {
    import: {
      effect: "read",
      idempotent: true,
      description: `Find a ${title} by its ${identity ? `${identity} or its ` : ""}binding id and read it; gone when there is none`,
      ...io.import,
      target,
      opaque,
    },
    read: {
      effect: "read",
      idempotent: true,
      description: `Read a ${title} as it is now; gone when it no longer exists`,
      ...io.read,
      target,
      opaque,
    },
  } satisfies Specs<S, "read" | "import">;
  const ops = (spec.vendorless ? {} : writable ? { ...base, ...changeOps } : base) as unknown as ResourceOps<S, W>;

  const named = new Set(identity?.match(/[A-Za-z_][\w.]*/g));
  const owned = new Set(fields.vendorOwned.filter((path) => !named.has(path)));
  const references: References = fields.references ?? {};
  const writeOnly = new Set(fields.writeOnly);
  for (const [path, ref] of Object.entries(references)) {
    if (ref.from !== undefined && ref.by !== undefined)
      throw new Error(
        `${what}: the reference at ${path} takes its value from its resource's state or names it by a field, not both`,
      );
    // A write-only field holds secret markers only, never a value from another resource's state.
    if (ref.from !== undefined && underAny(path, writeOnly))
      throw new Error(`${what}: ${path} is write-only, so it cannot take its value from another resource's state`);
    const inside = ref.from === undefined ? undefined : fields.writeOnly.find((w) => w.startsWith(`${path}.`));
    if (inside !== undefined)
      throw new Error(
        `${what}: ${inside} is write-only, so ${path}, which holds it, cannot take its value from another resource's state`,
      );
  }
  const declare = (
    given: Declaring<z.input<S>, R>,
    options?: { connection?: ConnectionRef },
  ): Declared<`${V}.${T}`, z.input<S>> => {
    const connection = options?.connection;
    if (
      connection &&
      (connection.vendor !== vendor || !new RegExp(`^${vendor}/[a-z][a-z0-9-]{0,63}$`).test(connection.$connection))
    ) {
      throw new Error(`${what}: select a declared connection of this connector`);
    }
    const refs: Record<string, string> = {};
    // Where a secret, or a resource a `from` reference takes, is given, with list items' indexes:
    // the schema does not judge the marker, nor the name that holds the place of the state.
    const unjudged = new Set<string>();
    // Each resource `given` names, where `references` allows one of its type, replaced by its name.
    // `path` is the field's, as `references` names it; `at` has list items' indexes too.
    const resolve = (value: unknown, path: string, at: string): unknown => {
      if (isSecret(value)) {
        if (!underAny(path, writeOnly)) {
          throw new Error(`${what}: ${at} is not write-only, so it takes a value, not a secret (${value.$secret})`);
        }
        const hostSecrets = host?.inputs.secrets;
        if (isSanomaSecret(value.$secret) && !(hostSecrets !== undefined && underAny(path, new Set([hostSecrets])))) {
          throw new Error(`${what}: ${at} names ${value.$secret}, one of sanoma's own: only a host's secrets may`);
        }
        unjudged.add(at);
        return value;
      }
      if (isDeclared(value)) {
        const id = value[DECLARED];
        const wants = references[path];
        if (wants === undefined) throw new Error(`${what}: ${at} takes a value, not a resource (${id} ${value.name})`);
        const types = [wants.type].flat();
        if (!types.includes(id))
          throw new Error(`${what}: ${at} names a resource of type ${types.join(" or ")}, not ${id} (${value.name})`);
        if (value.name === undefined) {
          // A resource with no identity (a Neon project) stands for nothing the vendor reads: only a
          // field the vendor is never sent, or one that takes its state (`from`), may name it, and
          // the loader puts the declaration's id there (`readResources`).
          if (!underAny(path, writeOnly) && wants.from === undefined) {
            throw new Error(
              `${what}: ${at} names a ${id}, which has no identity to name it by: only a write-only field or a \`from\` reference may`,
            );
          }
          unjudged.add(at);
          refs[at] = id;
          return undefined;
        }
        if (wants.from !== undefined) unjudged.add(at);
        refs[at] = `${id}:${value.name}`;
        return value.name;
      }
      if (Array.isArray(value)) {
        const from = references[path]?.from;
        const listed = from === undefined ? undefined : value.find(isDeclared);
        if (listed) throw new Error(`${what}: ${path} takes a ${listed[DECLARED]}'s ${from} as a whole, not in a list`);
        return value.map((item, i) => resolve(item, path, `${at}.${i}`));
      }
      if (!isObject(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([field, v]) => [field, resolve(v, joinPath(path, field), joinPath(at, field))]),
      );
    };
    const desired = resolve(given, "", "") as z.input<S>;
    const unknown = Object.keys(desired ?? {}).filter((name) => !Object.hasOwn(schema.shape, name));
    if (unknown.length) throw new Error(`${what}: no field ${unknown.join(", ")}`);
    // Apply fills a host's revision from its ref: the file names a branch, never a commit.
    if (host && pathsIn(desired, new Set([host.revision])).length) {
      throw new Error(`${what}: leave out ${host.revision}: apply sets it from ${host.inputs.ref}`);
    }
    // A host that derives is given its secrets and its sites' domains: a data file names neither.
    if (host?.derives) {
      const { secrets, domains } = host.inputs;
      if (secrets !== undefined && pathsIn(desired, new Set([secrets])).length) {
        throw new Error(
          `${what}: leave out ${secrets}: apply gives the host its database's URL, its keys and the connections it deploys with, and no secret is written in a file`,
        );
      }
      if (domains !== undefined && pathsIn(desired, new Set([domains])).length) {
        throw new Error(
          `${what}: leave out ${domains}: a public site's domain is declared on the site, \`defineSite({ public: true, domain })\`, and the host attaches it`,
        );
      }
    }
    const vendors = pathsIn(desired, owned);
    if (vendors.length) {
      throw new Error(
        `${what}: leave out ${vendors.join(", ")}: the vendor sets ${vendors.length > 1 ? "them" : "it"}`,
      );
    }
    const parsed = schema.safeParse(desired);
    const issues = parsed.error?.issues.filter((issue) => !unjudged.has(issue.path.join(".")));
    if (issues?.length) throw new Error(`${what}: ${z.prettifyError(new z.ZodError(issues))}`);
    const name = find?.(desired);
    if (find && (typeof name !== "string" || name === "")) throw new Error(`${what}: its ${identity} is missing`);
    return Object.freeze({
      [DECLARED]: what,
      vendor,
      type,
      ...(name !== undefined && { name }),
      desired,
      refs: Object.freeze(refs),
      ...(connection && { connection: Object.freeze({ ...connection }) }),
    });
  };
  const resource = Object.assign(declare, {
    vendor,
    type,
    title: spec.title,
    identity,
    schema,
    fields,
    find,
    bindingId: spec.bindingId ?? ((state: State) => String(state.id)),
    normalize: spec.normalize ?? ((state: State, desired: z.input<S>) => compareDeclared(fields, state, desired)),
    writable,
    ...(host && { host }),
    ...(wakeup && { wakeup }),
    ...(database && { database }),
    stateless: spec.stateless ?? host !== undefined,
    vendorless: spec.vendorless ?? false,
    ...(spec.afterCreate && { afterCreate: spec.afterCreate }),
    ...(spec.formerly?.length && { formerly: Object.freeze([...spec.formerly]) }),
    ops,
    // A symbol, so `defineConnector` tells a resource type from a group of operations.
    [RESOURCE]: true as const,
  });
  return Object.freeze(resource);
}

/**
 * Throws where a `from` reference (`FieldReference.from`) names a path that a type it may name
 * has no field at, among `types` (a config's): `dns_record` for `dns_records` would otherwise
 * fail every create. A type not among them is left to the data files' check.
 */
export function checkFromRefs(types: ReadonlyMap<string, Resource>): void {
  for (const type of types.values()) {
    for (const [path, ref] of Object.entries(type.fields.references ?? {})) {
      const named = ref.from === undefined ? [] : [ref.type].flat();
      for (const held of named.map((id) => types.get(id)).filter((t) => t !== undefined)) {
        if (!hasPath(held.schema, ref.from!)) {
          const shape = (held.schema as Partial<z.ZodObject>).shape ?? {};
          throw new Error(
            `${type.vendor}.${type.type}: the reference at ${path} takes ${ref.from} from a ${held.vendor}.${held.type}'s state, which has no such field (its fields: ${Object.keys(shape).join(", ")})`,
          );
        }
      }
    }
  }
}

/** Every resource type the connectors declare, by `<vendor>.<type>`. */
export function resourceTypesOf(connectors: readonly Connector<any, any>[]): Map<string, Resource> {
  const types = new Map<string, Resource>();
  for (const connector of connectors) {
    for (const r of connector[VENDOR].resources as readonly Resource[]) types.set(`${r.vendor}.${r.type}`, r);
  }
  return types;
}
