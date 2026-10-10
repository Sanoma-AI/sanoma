import {
  type Connector,
  defineConnector,
  defineDriver,
  defineResource,
  type Driver,
  type DriverFn,
  DriverError,
  type References,
  type Resource,
  type ResourceSpec,
  type VendorInfo,
} from "@sanoma/workflows";
import type { z } from "zod";
import { BridgeError, type ResourceState } from "./bridge.ts";
import { ensureConfigured, type ProviderClient } from "./configure.ts";
import { fromTfState, toTfState } from "./tfschema/state.ts";
import type { TfProvider, TfResourceType } from "./tfschema/types.ts";

/** One resource type of an OpenTofu connector: its generated type, and what the provider's schema does not say. */
export interface TfTypeSpec<S extends z.ZodObject = z.ZodObject> {
  /** The type from `resources.gen.ts`: its provider type name, schema, flagged fields and state layout. */
  tf: TfResourceType<S>;
  /** What people call it, such as "Repository". */
  title: string;
  /** How `find` makes the import id, for people: `name`, `repository_id:pattern`. */
  identity: string;
  /** The provider's import id for a declared resource. */
  find: (desired: z.input<S>) => string;
  /** The part of a state a drift check compares; default `compareDeclared`. */
  normalize?: ResourceSpec<S>["normalize"];
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
  /** The generated types, by name. */
  readonly types: { readonly [K in keyof T]: TfResourceType<T[K]> };
  /**
   * The driver: each operation over `bridge`, with the provider configured with what `config`
   * returns, read on every call (it may throw, such as a `DriverError` for a missing token).
   */
  driver(bridge: ProviderClient, config: () => Record<string, unknown>): Driver;
}

/** The driver's data about an object: the provider's state version and private data, `<version>:<base64>`. */
const HANDLE = /^(\d+):([A-Za-z0-9+/]*={0,2})$/;
const handleOf = (r: ResourceState) => `${r.schemaVersion}:${Buffer.from(r.private).toString("base64")}`;

/**
 * A connector for a vendor with an OpenTofu provider, from the types `resources.gen.ts`
 * declares: each becomes a resource type (`defineResource`, its schema and fields generated)
 * with `read` and `import`, and the driver reads through the provider bridge.
 *
 * The driver's `import` asks the provider to find the object by its import id (the bridge reads
 * it too); `read` refreshes a state from an earlier call, or, given none (or one without an
 * `id`), imports. Either answers `{ gone: true }` when the provider finds no object, or fails
 * the way `missing` says means none. States go out in the resource's shape, secrets dropped (`fromTfState`), and
 * come back in the provider's (`toTfState`); the provider's private data and state version go
 * in the opaque `handle`. The provider is configured through `ensureConfigured`. The bridge's
 * errors become `DriverError`s with its code as `vendorCode` and the provider's diagnostics in
 * the message, retryable only when the provider has gone (`unavailable`).
 */
export function tfConnector<
  const V extends string,
  T extends Record<string, z.ZodObject>,
  const Refs extends TfReferences<T> = {},
>(spec: TfConnectorSpec<V, T, Refs>): TfConnector<V, T, Refs> {
  const { vendor, provider, missing = notFound } = spec;
  const types = spec.types as Record<string, TfTypeSpec>;
  const references: Record<string, References | undefined> = spec.references ?? {};
  const resources: Record<string, Resource> = Object.fromEntries(
    Object.entries(types).map(([type, { tf, title, identity, find, normalize }]) => [
      type,
      defineResource({
        vendor,
        type,
        title,
        identity,
        schema: tf.schema,
        fields: references[type] ? { ...tf.fields, references: references[type] } : tf.fields,
        find,
        ...(normalize && { normalize }),
      }),
    ]),
  );
  const connector = defineConnector(vendor, resources, spec.info);

  function driver(bridge: ProviderClient, config: () => Record<string, unknown>): Driver {
    /**
     * Runs `fn` on a configured provider, with the bridge's errors as `DriverError`s, but for
     * one that says the object `id` is missing: that is `{ id, gone: true }`.
     */
    async function call<R>(op: string, id: string, fn: () => Promise<R>): Promise<R | { id: string; gone: true }> {
      try {
        return await ensureConfigured(bridge, provider, JSON.stringify(config()), fn);
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        if (missing(e)) return { id, gone: true };
        const said = e.diagnostics.map((d) => (d.detail ? `${d.summary}: ${d.detail}` : d.summary)).join("; ");
        throw new DriverError(`${vendor}: ${op} failed (${e.code}): ${said || e.message}`, {
          retryable: e.code === "unavailable",
          vendorCode: e.code,
          cause: e,
        });
      }
    }

    const impl: Record<string, Record<string, DriverFn<any, any>>> = {};
    for (const [type, { tf }] of Object.entries(types)) {
      const out = (r: ResourceState) => ({
        state: fromTfState(tf.shape, JSON.parse(r.stateJson) as Record<string, unknown>),
        handle: handleOf(r),
      });
      const importOne = async (id: string) => {
        const { resources: found } = await bridge.import(provider, tf.typeName, id);
        const r = found.find((f) => f.typeName === tf.typeName);
        return r ? { id, gone: false, ...out(r) } : { id, gone: true };
      };
      impl[type] = {
        import: ({ id }: { id: string }) => call(`${type}.import`, id, () => importOne(id)),
        read: (input: { id: string; state?: Record<string, unknown>; handle?: string }) =>
          call(`${type}.read`, input.id, async () => {
            const state = input.state && toTfState(tf.shape, input.state);
            // No state to refresh, or none the provider can find again (it reads by `id`): an
            // import finds the object, and reads it.
            if (state?.id === undefined || state.id === null) return importOne(input.id);
            const handle = input.handle === undefined ? undefined : HANDLE.exec(input.handle);
            if (input.handle !== undefined && !handle) {
              throw new DriverError(`${vendor}: ${type}.read was given a handle it did not make`, { retryable: false });
            }
            const reply = await bridge.read(
              provider,
              tf.typeName,
              JSON.stringify(state),
              handle ? Buffer.from(handle[2]!, "base64") : undefined,
              handle ? Number(handle[1]) : tf.schemaVersion,
            );
            if (reply.gone || !reply.resource) return { id: input.id, gone: true };
            return { id: input.id, gone: false, ...out(reply.resource) };
          }),
      };
    }
    return defineDriver(connector, impl as never);
  }

  return {
    vendor,
    provider,
    connector: connector as unknown as Connector<V, TfResources<V, T, Refs>>,
    resources: resources as unknown as TfResources<V, T, Refs>,
    types: Object.fromEntries(Object.entries(types).map(([type, { tf }]) => [type, tf])) as TfConnector<V, T>["types"],
    driver,
  };
}
