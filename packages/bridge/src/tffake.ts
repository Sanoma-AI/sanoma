import type { Driver, DriverFn, OpIdOf } from "@sanoma/workflows";
import { defineFake, type Fake, type FakeOptions } from "@sanoma/workflows/fake";
import type { z } from "zod";
import type { TfConnector, TfResources } from "./connector.ts";
import { fixturesDir } from "./pins.ts";
import { type BridgeState, loadReplies, stateBridge } from "./replies.ts";
import { toTfState } from "./tfschema/state.ts";

/** A connector fake's state: the objects its bridge serves, as `loadReplies` loads them. */
export type TfFakeState = BridgeState;

export interface TfFakeOptions extends FakeOptions {
  /** Where the recorded replies are (`replies/<release>/…`). Default: `@sanoma/bridge`'s own `testdata/`. */
  fixtures?: string | URL;
}

/** A connector's fake: its faults, and `override` and `remove` to change the vendor's objects between calls. */
export type TfFake<V extends string, T extends Record<string, z.ZodObject>> = Fake<
  TfFakeState,
  OpIdOf<V, TfResources<T>>
> & {
  /**
   * Sets fields of the object of type `type` and import id `id`, in the resource's shape, for
   * the next `read` and `import` to return, as if someone edited the object at the vendor.
   */
  override<K extends keyof T & string>(type: K, id: string, fields: Partial<z.input<T[K]>>): void;
  /** Deletes the object: the next `read` of it says it is gone, and `import` finds nothing. */
  remove(type: keyof T & string, id: string): void;
};

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
 * and `override` and `remove` to simulate drift. With `file`, another process's fake on the same
 * file sees the changes.
 */
export function tfFake<V extends string, T extends Record<string, z.ZodObject>>(
  tf: TfConnector<V, T>,
  options: TfFakeOptions = {},
): TfFake<V, T> {
  const { fixtures = fixturesDir, ...fakeOptions } = options;
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
  return Object.assign(fake, {
    override<K extends keyof T & string>(type: K, id: string, fields: Partial<z.input<T[K]>>) {
      const { shape } = tf.types[type];
      const names = Object.keys(fields);
      const unknown = names.filter((n) => !shape.attributes.includes(n) && !Object.hasOwn(shape.blocks ?? {}, n));
      if (unknown.length) throw new Error(`fake ${tf.vendor}: ${type} has no field ${unknown.join(", ")}`);
      const provider = toTfState(shape, fields as Record<string, unknown>);
      fake.update((state) => {
        const o = objectAt(state, type, id);
        for (const name of names) o.state[name] = provider[name];
      });
    },
    remove(type: keyof T & string, id: string) {
      fake.update((state) => {
        objectAt(state, type, id);
        delete state.objects[`${tf.types[type].typeName}/${id}`];
      });
    },
  });
}
