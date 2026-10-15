import type { Driver, DriverFn, OpIdOf } from "@sanoma-ai/workflows";
import { defineFake, type Fake, type FakeOptions, type ResourceFake } from "@sanoma-ai/workflows/fake";
import type { z } from "zod";
import type { TfConnector, TfResources } from "./connector.ts";
import type { FixtureError } from "./fixtures.ts";
import { fixturesDir } from "./pins.ts";
import { type BridgeState, loadReplies, stateBridge, type StateObject } from "./replies.ts";
import { toTfState } from "./tfschema/state.ts";

/** A connector fake's state: the objects its bridge serves, as `loadReplies` loads them. */
export type TfFakeState = BridgeState;

export interface TfFakeOptions extends FakeOptions {
  /** Where the recorded replies are (`replies/<release>/…`). Default: `@sanoma-ai/bridge`'s own `testdata/`. */
  fixtures?: string | URL;
  /**
   * What the provider answers an import of an object that is not there, by the connector's
   * type name and the import id: the bridge's error, as a fixture records one. Undefined, or
   * without this, the bridge's `not_found`. A connector's fake sets it where its provider says
   * it otherwise, as GitHub's does, so `remove` answers as the provider would.
   */
  missingReply?: (type: string, id: string) => FixtureError | undefined;
}

/**
 * A connector's fake: its faults, and `put`, `override` and `remove` to change the vendor's
 * objects between calls, typed by the connector's resources, as a `ResourceFake` (what a
 * scenario's resource steps need).
 */
export interface TfFake<V extends string, T extends Record<string, z.ZodObject>>
  extends Fake<TfFakeState, OpIdOf<V, TfResources<V, T>>>, ResourceFake {
  /**
   * Sets fields of the object of type `type` and import id `id`, in the resource's shape, for
   * the next `read` and `import` to return, as if someone edited the object at the vendor.
   */
  override<K extends keyof T & string>(type: K, id: string, fields: Partial<z.input<T[K]>>): void;
  /**
   * Puts an object of type `type` under import id `id`, with `fields` in the resource's shape,
   * as if it were made at the vendor: over a copy of the recorded object with import id `from`,
   * so it has the fields the vendor sets (replacing any object there, its provider `id` then
   * `fields.id`, else the import id), else over the object already there, whose other fields it
   * keeps, else over nothing.
   */
  put<K extends keyof T & string>(
    type: K,
    id: string,
    fields: Partial<z.input<T[K]>>,
    options?: { from?: string },
  ): void;
  /**
   * Deletes the object: the next `read` of it says it is gone, and `import` answers as the
   * provider does for a missing object (`missingReply`), which the driver reads as gone.
   * Nothing when there is no such object.
   */
  remove(type: keyof T & string, id: string): void;
}

/** A driver's flat operations (`repository.read`) grouped by resource again, as `defineFake` takes them. */
function grouped(driver: Driver) {
  const out: Record<string, Record<string, DriverFn>> = {};
  for (const [key, fn] of Object.entries(driver.ops)) {
    const [resource = "", name = ""] = key.split(".");
    (out[resource] ??= {})[name] = fn;
  }
  return out;
}

/**
 * A fake vendor for an OpenTofu connector: its real driver over a `stateBridge` of the replies
 * recorded from the provider, so nothing reaches the vendor and no credentials are read. It has
 * the faults every fake has (`failNext`, `loseReply`, `rateLimit`, `hold`, `reset`, `update`),
 * and `put`, `override` and `remove` to simulate drift. Each call makes one of its own, with
 * the recorded replies, as each sandbox run does.
 */
export function tfFake<V extends string, T extends Record<string, z.ZodObject>>(
  tf: TfConnector<V, T>,
  options: TfFakeOptions = {},
): TfFake<V, T> {
  const { fixtures = fixturesDir, missingReply, ...fakeOptions } = options;
  const fake = defineFake(
    tf.connector,
    {
      initial: (): TfFakeState => loadReplies(fixtures, tf.provider),
      ops: (state) => grouped(tf.driver(stateBridge(state), () => ({}))) as never,
    },
    fakeOptions,
  );
  const objectAt = (state: TfFakeState, type: keyof T & string, id: string) => {
    const at = `${tf.types[type].typeName}/${id}`;
    const o = state.objects[at];
    if (!o || "error" in o) throw new Error(`fake ${tf.vendor}: no object ${at}`);
    return o;
  };
  /** The fields in the provider's shape, refusing a field the type does not have. */
  const providerFields = (type: keyof T & string, fields: Record<string, unknown>) => {
    const { shape } = tf.types[type];
    const unknown = Object.keys(fields).filter(
      (n) => !shape.attributes.includes(n) && !Object.hasOwn(shape.blocks ?? {}, n),
    );
    if (unknown.length) throw new Error(`fake ${tf.vendor}: ${type} has no field ${unknown.join(", ")}`);
    const provider = toTfState(shape, fields);
    return Object.fromEntries(Object.keys(fields).map((name) => [name, provider[name]]));
  };
  return Object.assign(fake, {
    override<K extends keyof T & string>(type: K, id: string, fields: Partial<z.input<T[K]>>) {
      const set = providerFields(type, fields as Record<string, unknown>);
      fake.update((state) => {
        Object.assign(objectAt(state, type, id).state, set);
      });
    },
    put<K extends keyof T & string>(
      type: K,
      id: string,
      fields: Partial<z.input<T[K]>>,
      { from }: { from?: string } = {},
    ) {
      const set = providerFields(type, fields as Record<string, unknown>);
      const { typeName, schemaVersion } = tf.types[type];
      fake.update((state) => {
        const at = `${typeName}/${id}`;
        const there = state.objects[at];
        if (from === undefined && there && !("error" in there)) {
          Object.assign(there.state, set);
          return;
        }
        const o: StateObject =
          from === undefined
            ? { typeName, state: {}, private: "", schemaVersion }
            : structuredClone(objectAt(state, type, from));
        Object.assign(o.state, { id }, set);
        state.objects[at] = o;
      });
    },
    remove(type: keyof T & string, id: string) {
      const error = missingReply?.(type, id);
      fake.update((state) => {
        const at = `${tf.types[type].typeName}/${id}`;
        const there = state.objects[at];
        if (!there || "error" in there) return;
        if (error) state.objects[at] = { error };
        else delete state.objects[at];
      });
    },
  });
}
