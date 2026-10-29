import {
  type CallContext,
  type Connector,
  type DatabaseSpec,
  defineConnector,
  defineDriver,
  defineResource,
  type Driver,
  type DriverFn,
  DriverError,
  type HostSpec,
  type PlanAction,
  type References,
  type Resource,
  type ResourceFields,
  type ResourceSpec,
  resolveSecrets,
  type VendorInfo,
  withoutWriteOnly,
} from "@sanoma-ai/workflows";
import type { z } from "zod";
import {
  type ApplyInput,
  BridgeError,
  type Diagnostic,
  type PlanInput,
  type PlanResult,
  type ResourceState,
} from "./bridge.ts";
import { ensureConfigured, type ProviderClient } from "./configure.ts";
import { fromTfState, toTfState } from "./tfschema/state.ts";
import type { TfBlockShape, TfProvider, TfResourceType, TfShape } from "./tfschema/types.ts";

/**
 * A resource type whose declared fields are not its provider type's attributes (a host's
 * `{ name, image, source, ref, secrets, port }` over Docker's `docker_container`): its own schema
 * and flagged fields, and how its fields map onto the provider's and back, both in the resource's
 * shape (`fromTfState`'s). The driver maps each config it sends and each state it returns.
 */
export interface TfMapped<S extends z.ZodObject = z.ZodObject> {
  /** The provider's type it is stored as, from `resources.gen.ts`. */
  over: TfResourceType;
  /** Its fields as `read` returns them, which a data file declares. */
  schema: S;
  fields: ResourceFields;
  /** The provider's attributes for declared fields, their secrets resolved: what create and update send. */
  toProvider: (desired: z.output<S>) => Record<string, unknown>;
  /** The declared fields of a provider state, its write-only attributes `null` already. */
  fromProvider: (state: Record<string, unknown>) => z.input<S>;
}

/** One resource type of an OpenTofu connector: its generated type, and what the provider's schema does not say. */
export interface TfTypeSpec<S extends z.ZodObject = z.ZodObject> {
  /**
   * The type from `resources.gen.ts`: its provider type name, schema, flagged fields and state
   * layout; or a type of other fields mapped onto one (`TfMapped`).
   */
  tf: TfResourceType<S> | TfMapped<S>;
  /** What people call it, such as "Repository". */
  title: string;
  /** How `find` makes the identity, for people: `name`, `repository_id:pattern`. Absent with `find`. */
  identity?: string;
  /** The provider's import id for a declared resource before it is bound; absent when its fields cannot name it. */
  find?: (desired: z.input<S>) => string;
  /** The id a binding keeps, from the resource's state; default `String(state.id)`. */
  bindingId?: ResourceSpec<S>["bindingId"];
  /** The part of a state a drift check compares; default `compareDeclared`. */
  normalize?: ResourceSpec<S>["normalize"];
  /**
   * False for a state the provider returned for no object; default: every state is one. For a
   * provider that answers a missing object with the state it was given (Supabase's answers a
   * project's 404 so): the type's `read` then imports by id instead of refreshing the state, so
   * the provider answers from the id alone, and such a state is gone.
   */
  exists?: (state: Record<string, unknown>) => boolean;
  /**
   * True when apply may change its objects: the type has `plan`, `create`, `update` and
   * `delete`, each read, planned and applied through the bridge in one call. Default false.
   */
  writable?: boolean;
  /** True when its objects hold no data, so apply makes one gone again without asking (`ResourceSpec.stateless`). */
  stateless?: boolean;
  /** Operations apply calls after it creates one (`ResourceSpec.afterCreate`). */
  afterCreate?: ResourceSpec<S>["afterCreate"];
  /**
   * Fields, by dotted path, that hold a secret the provider does not mark sensitive (Docker's
   * container `env`): write-only besides the generated ones, so no output carries them. Each
   * must be optional (nullish in the schema): an output holds it as `null`. For a `TfMapped`
   * type, the provider's attributes: no state reaches `fromProvider` with them.
   */
  writeOnly?: readonly string[];
  /** Set when the type meets the `Host` contract (`ResourceSpec.host`). */
  host?: HostSpec;
  /** Set when the type meets the `Database` contract (`ResourceSpec.database`). */
  database?: DatabaseSpec;
}

/** Per resource type, its `fields.references`: `{ branch_protection: { repository_id: { type: "github.repository" } } }`. */
export type TfReferences<T> = { readonly [K in keyof T]?: References };

export interface TfConnectorSpec<V extends string, T extends Record<string, z.ZodObject>, R extends TfReferences<T>> {
  /** The vendor's id, such as `github`: the operations are `<vendor>.<type>.read` and `.import`. */
  vendor: V;
  /** The provider release, `provider` from `resources.gen.ts`. */
  provider: TfProvider;
  /** The resource types, by the connector's name for each (`repository`). */
  types: { [K in keyof T]: TfTypeSpec<T[K]> };
  /**
   * Per type, the fields that name another declared resource, which the provider's schema does
   * not say (it types them as strings): a data file gives the resource itself there.
   */
  references?: R;
  /**
   * True when the provider's error means there is no such object, which `import` (and a `read`
   * that imports) then answers `{ gone: true }`. Default: the bridge's `not_found`. A provider
   * may say it otherwise: GitHub's answers `failed_precondition`, with a diagnostic.
   */
  missing?: (error: BridgeError) => boolean;
  /** Who the vendor is, for a UI: `defineConnector`'s third argument. */
  info?: VendorInfo;
}

const notFound = (error: BridgeError) => error.code === "not_found";

/** A connector's resource types, by name. */
export type TfResources<V extends string, T extends Record<string, z.ZodObject>, R extends TfReferences<T> = {}> = {
  readonly [K in keyof T & string]: Resource<T[K], `${V}.${K}`, R[K] extends References ? R[K] : {}>;
};

/** What `tfConnector` returns: the connector, its resource types, and how to drive them. */
export interface TfConnector<V extends string, T extends Record<string, z.ZodObject>, R extends TfReferences<T> = {}> {
  readonly vendor: V;
  readonly provider: TfProvider;
  /** The connector, with each resource type's `read` and `import`, for `defineConfig` and workflows. */
  readonly connector: Connector<V, TfResources<V, T, R>>;
  /** The resource types, which declare resources in data files: `resources.repository({ name: "sanoma" })`. */
  readonly resources: TfResources<V, T, R>;
  /** The provider's types, from `resources.gen.ts`, by name: a `TfMapped` type's is the one it is stored as. */
  readonly types: { readonly [K in keyof T]: TfResourceType };
  /**
   * The driver: each operation over `bridge`, with the provider configured with what `config`
   * returns, read on every call (it may throw, such as a `DriverError` for a missing token).
   * `importId`, given, turns the id an import is given (a binding id the provider cannot import
   * by, such as GitHub's node id) into the provider's import id, by the connector's type name.
   * `observe`, given, completes each state an import returns.
   */
  driver(bridge: ProviderClient, config: () => Record<string, unknown>, importId?: ImportId, observe?: Observe): Driver;
}

/** The provider's import id for the id an import is given, by the connector's type name. */
export type ImportId = (type: string, id: string) => string | Promise<string>;

/**
 * An imported state, in the provider's shape, with what the provider's read leaves out filled in
 * from the vendor (Docker's provider never reads a container's environment or labels back), by
 * the connector's type name. It runs inside the driver, before anything else reads the state.
 */
export type Observe = (type: string, state: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The driver's data about an object: the provider's state version and private data, `<version>:<base64>`. */
const HANDLE = /^(\d+):([A-Za-z0-9+/]*={0,2})$/;
const handleOf = (r: ResourceState) => `${r.schemaVersion}:${Buffer.from(r.private).toString("base64")}`;

/** `shape` with each of `paths` (dotted, through blocks) secret too, so `fromTfState` drops its value. */
function withSecrets(shape: TfShape, paths: readonly string[]): TfShape {
  if (!paths.length) return shape;
  const here = new Set(shape.secret);
  const below = new Map<string, string[]>();
  for (const path of paths) {
    const [name = "", ...rest] = path.split(".");
    // A path into an attribute (an object, not a block) hides the whole attribute.
    if (rest.length && shape.blocks?.[name]) below.set(name, [...(below.get(name) ?? []), rest.join(".")]);
    else here.add(name);
  }
  const blocks = Object.fromEntries(
    Object.entries(shape.blocks ?? {}).map(([name, block]) => [
      name,
      { ...block, shape: withSecrets(block.shape, below.get(name) ?? []) },
    ]),
  );
  return { ...shape, secret: [...here], ...(shape.blocks && { blocks }) };
}

/** A provider's path (`rules[0].name`, `tags["env"]`) as a dotted one in the resource's shape (`rules.0.name`, `tags.env`). */
export function resourcePath(shape: TfShape, path: string): string {
  const out: string[] = [];
  let at: TfShape | undefined = shape;
  let one = false;
  for (const [, name, index, key] of path.matchAll(/\.?([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g)) {
    if (name !== undefined) {
      const block: TfBlockShape | undefined = at?.blocks?.[name];
      out.push(name);
      at = block?.shape;
      one = block?.one ?? false;
    } else if (index !== undefined) {
      // A block of at most one item is an object in the resource's shape: its index goes.
      if (!one) out.push(index);
      one = false;
    } else if (key !== undefined) {
      out.push(JSON.parse(`"${key}"`) as string);
    }
  }
  return out.join(".");
}

/** The prior state a plan or apply starts from: the object as last read. */
const priorOf = (r: ResourceState): PlanInput => ({
  priorStateJson: r.stateJson,
  priorPrivate: r.private,
  priorSchemaVersion: r.schemaVersion,
});

const said = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .map((d) => {
      const what = d.detail ? `${d.summary}: ${d.detail}` : d.summary;
      return d.attributePath ? `${d.attributePath}: ${what}` : what;
    })
    .join("; ");

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const other = b.toSorted();
  return a.length === b.length && a.toSorted().every((item, i) => item === other[i]);
};

/**
 * A connector for a vendor with an OpenTofu provider, from the types `resources.gen.ts`
 * declares: each becomes a resource type (`defineResource`, its schema and fields generated)
 * with `read` and `import`, and for a `writable` type the change operations, and the driver
 * goes through the provider bridge.
 *
 * The driver's `import` asks the provider to find the object by its import id (the bridge reads
 * it too), made from the id it is given by `importId` when the driver has one; `read` refreshes
 * a state from an earlier call, or, given none (or one without an `id`, or for a type with `exists`), imports. Either answers `{ gone: true }` when the provider finds no object (or one `exists` refuses), or fails
 * the way `missing` says means none. States go out in the resource's shape, every write-only
 * field (the provider's sensitive and write-only attributes, and the type's `writeOnly`) `null`
 * (`fromTfState`), and come back in the provider's (`toTfState`); the provider's private data
 * and state version go in the opaque `handle`.
 *
 * Each change operation reads the object first (as `read` does), then plans and applies within
 * the one call: `plan` plans only, `create` plans a create and applies it, `update` plans from the
 * fresh state and applies it (a replace as a delete, then a create of the plan's new object),
 * and `delete` plans a delete and applies it, done already when the object is gone. Secret
 * markers in `desired` are resolved (`resolveSecrets`) just before the bridge sees them; the
 * plan's `planned` leaves write-only fields out, and its paths are the resource's (`rules.0.name`).
 * The provider's errors in an apply fail the call, naming the object it left, and in a replace the one already deleted.
 *
 * The provider is configured through `ensureConfigured`. The bridge's errors become
 * `DriverError`s with its code as `vendorCode` and the provider's diagnostics (with their
 * attribute paths) in the message, retryable only when the provider has gone (`unavailable`).
 */
export function tfConnector<
  const V extends string,
  T extends Record<string, z.ZodObject>,
  const Refs extends TfReferences<T> = {},
>(spec: TfConnectorSpec<V, T, Refs>): TfConnector<V, T, Refs> {
  const { vendor, provider, missing = notFound } = spec;
  const types = spec.types as Record<string, TfTypeSpec>;
  const references: Record<string, References | undefined> = spec.references ?? {};
  /** The provider's type a type is stored as, and its mapping when it has one. */
  const providerOf = (tf: TfTypeSpec["tf"]) =>
    "over" in tf ? { gen: tf.over, mapped: tf } : { gen: tf, mapped: undefined };
  /** The provider's write-only attributes: the generated ones and the type's `writeOnly`. */
  const secretsOf = ({ tf, writeOnly = [] }: TfTypeSpec) => [
    ...new Set([...providerOf(tf).gen.fields.writeOnly, ...writeOnly]),
  ];
  const resources: Record<string, Resource> = Object.fromEntries(
    Object.entries(types).map(([type, typeSpec]) => {
      const {
        tf,
        title,
        identity,
        find,
        bindingId,
        normalize,
        writable,
        stateless,
        writeOnly,
        host,
        database,
        afterCreate,
      } = typeSpec;
      return [
        type,
        defineResource({
          vendor,
          type,
          title,
          ...(identity !== undefined && { identity }),
          schema: tf.schema,
          fields: {
            ...tf.fields,
            ...(!("over" in tf) && writeOnly?.length && { writeOnly: secretsOf(typeSpec) }),
            ...(references[type] && { references: references[type] }),
          },
          ...(find && { find }),
          ...(bindingId && { bindingId }),
          ...(normalize && { normalize }),
          ...(writable && { writable }),
          ...(stateless && { stateless }),
          ...(host && { host }),
          ...(database && { database }),
          ...(afterCreate && { afterCreate }),
        }),
      ];
    }),
  );
  const connector = defineConnector(vendor, resources, spec.info);

  function driver(
    bridge: ProviderClient,
    config: () => Record<string, unknown>,
    importId: ImportId = (_, id) => id,
    observe?: Observe,
  ): Driver {
    /** Runs `fn` on a configured provider, with the bridge's errors as `DriverError`s. */
    async function call<R>(op: string, fn: () => Promise<R>): Promise<R> {
      try {
        return await ensureConfigured(bridge, provider, JSON.stringify(config()), fn);
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        throw new DriverError(`${vendor}: ${op} failed (${e.code}): ${said(e.diagnostics) || e.message}`, {
          retryable: e.code === "unavailable",
          vendorCode: e.code,
          cause: e,
        });
      }
    }
    const impl: Record<string, Record<string, DriverFn<any, any>>> = {};
    for (const [type, typeSpec] of Object.entries(types)) {
      const { exists, writable } = typeSpec;
      const { gen: tf, mapped } = providerOf(typeSpec.tf);
      const { fields, bindingId } = resources[type]!;
      const shape = withSecrets(tf.shape, secretsOf(typeSpec));
      /** A provider state as the resource's: in its shape, without secrets, mapped to its fields. */
      const stateOf = (json: string) => {
        const state = fromTfState(shape, JSON.parse(json) as Record<string, unknown>);
        return mapped ? (mapped.fromProvider(state) as Record<string, unknown>) : state;
      };
      const out = (r: ResourceState) => ({ state: stateOf(r.stateJson), handle: handleOf(r) });
      /** The object as the provider has it now, or undefined when there is none (or one `exists` refuses). */
      const importRaw = async (id: string) => {
        const { resources: found } = await bridge.import(provider, tf.typeName, await importId(type, id));
        const at = found.find((f) => f.typeName === tf.typeName);
        const r =
          at && observe
            ? {
                ...at,
                stateJson: JSON.stringify(await observe(type, JSON.parse(at.stateJson) as Record<string, unknown>)),
              }
            : at;
        return r && (!exists || exists(stateOf(r.stateJson))) ? r : undefined;
      };
      const fresh = async (op: string, input: Known): Promise<ResourceState | undefined> => {
        try {
          const state = input.state && !mapped ? toTfState(tf.shape, input.state) : undefined;
          // No state to refresh, none the provider can find again (it reads by `id`), a provider
          // that would echo a missing object's state, or a mapped type's (not the provider's
          // shape): an import finds the object, and reads it.
          if (exists || mapped || state?.id === undefined || state.id === null) return await importRaw(input.id);
          const handle = input.handle === undefined ? undefined : HANDLE.exec(input.handle);
          if (input.handle !== undefined && !handle) {
            throw new DriverError(`${vendor}: ${op} was given a handle it did not make`, { retryable: false });
          }
          const reply = await bridge.read(
            provider,
            tf.typeName,
            JSON.stringify(state),
            handle ? Buffer.from(handle[2]!, "base64") : undefined,
            handle ? Number(handle[1]) : tf.schemaVersion,
          );
          return reply.gone ? undefined : reply.resource;
        } catch (e) {
          if (e instanceof BridgeError && missing(e)) return undefined;
          throw e;
        }
      };
      const found = (id: string, r: ResourceState | undefined) =>
        r ? { id, gone: false, ...out(r) } : { id, gone: true };
      impl[type] = {
        import: ({ id }: { id: string }) =>
          call(`${type}.import`, async () => found(id, await fresh(`${type}.import`, { id }))),
        read: (input: Known) => call(`${type}.read`, async () => found(input.id, await fresh(`${type}.read`, input))),
      };
      if (!writable) continue;

      /**
       * The provider's config from declared fields: secrets resolved, every attribute present. For
       * a plan (`dryRun`), a secret to generate that is not stored yet gets a throwaway value, not stored.
       */
      const configOf = async (desired: Record<string, unknown>, ctx: CallContext, dryRun = false) => {
        const { secrets } = ctx;
        const view = dryRun
          ? {
              get: (name: string) => secrets.get(name),
              ensure: async (name: string, make: () => string) => (await secrets.get(name)) ?? make(),
            }
          : secrets;
        const resolved = await resolveSecrets(desired, view);
        return JSON.stringify(
          toTfState(tf.shape, mapped ? mapped.toProvider(mapped.schema.parse(resolved)) : resolved),
        );
      };
      const paths = (list: readonly string[]) => list.map((path) => resourcePath(tf.shape, path));
      const plan = (prior: ResourceState | undefined, configJson?: string) =>
        bridge.plan(provider, tf.typeName, {
          ...(prior && priorOf(prior)),
          ...(configJson !== undefined && { configJson }),
        });
      /** Applies `request`; `replaced`, the id of the object a replace already deleted, for the error. */
      const apply = async (op: string, request: ApplyInput, replaced?: string) => {
        const reply = await bridge.apply(provider, tf.typeName, request);
        if (!reply.errors.length) return reply.resource;
        const left = reply.resource && bindingId(stateOf(reply.resource.stateJson));
        const notes = [replaced && `${replaced} was deleted to replace it`, left && `the provider left ${left}`];
        const note = notes.filter(Boolean).join("; ");
        throw new DriverError(`${vendor}: ${op} failed${note ? ` (${note})` : ""}: ${said(reply.errors)}`, {
          retryable: false,
          vendorCode: "apply_failed",
        });
      };
      /** A create or update's output: the object it left, by its binding id. */
      const changed = (op: string, r: ResourceState | undefined) => {
        if (!r) throw new DriverError(`${vendor}: ${op}: the provider returned no object`, { retryable: false });
        const o = out(r);
        return { id: bindingId(o.state), ...o };
      };
      /** Creates the object a create plan (or a replace's) describes. */
      const create = async (op: string, configJson: string, p: PlanResult, replaced?: string) =>
        changed(op, await apply(op, { configJson, planned: p.planned, plannedPrivate: p.plannedPrivate }, replaced));

      Object.assign(impl[type], {
        plan: (input: Known & { id?: string; desired?: Record<string, unknown> }, ctx: CallContext) =>
          call(`${type}.plan`, async () => {
            const prior = input.id === undefined ? undefined : await fresh(`${type}.plan`, input as Known);
            if (!prior && input.desired === undefined) return { action: "none", unknown: [], replace: [] };
            const p = await plan(prior, input.desired && (await configOf(input.desired, ctx, true)));
            return {
              action: p.action,
              ...(p.plannedStateJson && { planned: withoutWriteOnly(fields, stateOf(p.plannedStateJson)) }),
              unknown: paths(p.unknownPaths),
              replace: paths(p.requiresReplace),
            };
          }),
        create: ({ desired }: { desired: Record<string, unknown> }, ctx: CallContext) =>
          call(`${type}.create`, async () => {
            const configJson = await configOf(desired, ctx);
            return create(`${type}.create`, configJson, await plan(undefined, configJson));
          }),
        update: (
          input: Known & { desired: Record<string, unknown>; expect?: { action: PlanAction; replace: string[] } },
          ctx: CallContext,
        ) => {
          const op = `${type}.update`;
          // A replace whose delete went through, for a second try (the bridge restarted): it only creates.
          let deleted: { configJson: string; plan: PlanResult } | undefined;
          return call(op, async () => {
            if (deleted) return create(op, deleted.configJson, deleted.plan, input.id);
            const prior = await fresh(op, input);
            if (!prior)
              throw new DriverError(`${vendor}: ${op}: ${input.id} is gone`, { retryable: false, vendorCode: "gone" });
            const configJson = await configOf(input.desired, ctx);
            const p = await plan(prior, configJson);
            const replace = paths(p.requiresReplace);
            const { expect } = input;
            if (expect && (expect.action !== p.action || !sameSet(expect.replace, replace))) {
              throw new DriverError(
                `${vendor}: ${op}: ${input.id} was planned to ${expect.action}, and now plans to ${p.action}` +
                  (replace.length ? ` (replacing for ${replace.join(", ")})` : ""),
                { retryable: false, vendorCode: "plan_changed" },
              );
            }
            if (p.action === "none") return { id: input.id, ...out(prior) };
            if (p.action !== "replace") {
              const { planned, plannedPrivate } = p;
              return changed(op, await apply(op, { ...priorOf(prior), configJson, planned, plannedPrivate }));
            }
            // A replace: the old object deleted, then the plan's new one created.
            await apply(op, priorOf(prior));
            deleted = { configJson, plan: p };
            return create(op, configJson, p, input.id);
          });
        },
        delete: (input: Known) =>
          call(`${type}.delete`, async () => {
            const op = `${type}.delete`;
            const prior = await fresh(op, input);
            if (prior) {
              await plan(prior);
              await apply(op, priorOf(prior));
            }
            return { id: input.id, gone: true };
          }),
      });
    }
    // Named accounts require provider sessions isolated by connection (B1). Never ignore a selector.
    const isolated = Object.fromEntries(
      Object.entries(impl).map(([group, functions]) => [
        group,
        Object.fromEntries(
          Object.entries(functions).map(([name, fn]) => [
            name,
            (input: unknown, ctx: CallContext) => {
              if (ctx.connection)
                throw new DriverError("Named connections require isolated provider sessions", { retryable: false });
              return (fn as (input: unknown, ctx: CallContext) => unknown)(input, ctx);
            },
          ]),
        ),
      ]),
    );
    return defineDriver(connector, isolated as never);
  }

  return {
    vendor,
    provider,
    connector: connector as unknown as Connector<V, TfResources<V, T, Refs>>,
    resources: resources as unknown as TfResources<V, T, Refs>,
    types: Object.fromEntries(Object.entries(types).map(([type, { tf }]) => [type, providerOf(tf).gen])) as TfConnector<
      V,
      T
    >["types"],
    driver,
  };
}

/** What `read`, and each change operation but `create`, is given of an object. */
interface Known {
  id: string;
  state?: Record<string, unknown>;
  handle?: string;
}
