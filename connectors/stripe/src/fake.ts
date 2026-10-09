import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFake, type FakeOptions } from "@sanoma/workflows/fake";
import { type Diagnostic, type ReplayObject, type ReplayState, replayBridge } from "./bridge.ts";
import { stripeOps, TYPES } from "./driver.ts";
import { stripe } from "./index.ts";

/** The replies recorded from the real provider (provider-bridge `testdata/replies`), shipped with the package. */
const REPLIES = fileURLToPath(new URL("../testdata/replies/", import.meta.url));

export type FakeStripeState = ReplayState & Record<string, unknown>;

export interface FakeStripeOptions extends FakeOptions {
  /** A directory of recorded replies laid out as provider-bridge's `testdata/replies/<provider>/`. Default: the package's own. */
  replies?: string;
}

/**
 * A Stripe that answers through the real driver over a replay of the bridge: `import` and
 * `read` return the objects in `testdata/replies`, a test-mode product (`prod_SanomaTest0001`)
 * and webhook endpoint (`we_SanomaTest0001`). Those replies are written by hand to the
 * provider's schema, not recorded: no Stripe key was at hand when the GitHub ones were.
 * Nothing reaches Stripe.
 *
 * `override` changes what the next read returns, as if someone edited the object in Stripe's
 * dashboard, and `remove` deletes it, so the next read says it is gone.
 */
export function fakeStripe(options: FakeStripeOptions = {}) {
  const { replies = REPLIES, ...fakeOptions } = options;
  const fake = defineFake(
    stripe,
    {
      initial: (): FakeStripeState => loadReplies(replies),
      ops: (state) => stripeOps(replayBridge(state), () => ({ api_key: "fake", stripe_account: null })),
    },
    fakeOptions,
  );
  /** Applies `change` to the state, and to the fake's file, if it keeps one, which the next call reads. */
  const edit = (change: (state: ReplayState) => void) => {
    change(fake.state);
    const { file } = fakeOptions;
    if (!file || !existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as { state: ReplayState };
    change(saved.state);
    writeFileSync(file, JSON.stringify(saved, null, 2));
  };
  return Object.assign(fake, {
    /**
     * Sets fields of the object `type` and import `id` name, as the provider's state holds them
     * (a block is a list), for the next `read` and `import` to return.
     */
    override(type: keyof typeof TYPES, id: string, fields: Record<string, unknown>) {
      edit((state) => {
        const o = state.objects[key(type, id)];
        if (!o || "error" in o) throw new Error(`fakeStripe: no recorded ${key(type, id)}`);
        Object.assign(o.state, fields);
      });
    },
    /** Deletes the object: the next `read` of it says it is gone, and `import` finds nothing. */
    remove(type: keyof typeof TYPES, id: string) {
      edit((state) => {
        delete state.objects[key(type, id)];
      });
    },
  });
}

/** An object's key in the replay state: its provider type and import id. */
const key = (type: keyof typeof TYPES, id: string) => `${TYPES[type].typeName}/${id}`;

const subdirs = (path: string) => readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory());

/**
 * Loads `<dir>/<provider>/<type>/<dir>/{import,read}.json` into a replay state: each object by
 * its type and import id (the import request's `id`), with the state its `read.json` returned,
 * else its import's, or the failure its import was answered with.
 */
export function loadReplies(dir: string): FakeStripeState {
  const objects: ReplayState["objects"] = {};
  for (const providerDir of subdirs(dir)) {
    for (const typeDir of subdirs(join(dir, providerDir.name))) {
      for (const objectDir of subdirs(join(dir, providerDir.name, typeDir.name))) {
        const path = join(dir, providerDir.name, typeDir.name, objectDir.name);
        const json = (file: string) => JSON.parse(readFileSync(join(path, file), "utf8"));
        const imported = json("import.json") as Recorded<{ resources: Reply[] }>;
        const at = `${imported.request.typeName}/${imported.request.id}`;
        if ("error" in imported.response) {
          objects[at] = { error: imported.response.error };
          continue;
        }
        const read = existsSync(join(path, "read.json"))
          ? (json("read.json") as Recorded<{ resource: Reply }>)
          : undefined;
        const reply = read && !("error" in read.response) ? read.response.resource : imported.response.resources[0];
        if (reply) objects[at] = objectOf(reply);
      }
    }
  }
  return { objects };
}

/** A recorded call, as provider-bridge's recorder writes it: the response in Connect's JSON form. */
interface Recorded<R> {
  request: { typeName: string; id?: string };
  response: R | { error: { code: string; message: string; diagnostics?: Diagnostic[] } };
}

/** A `Resource` in Connect's JSON form: int64 as a string, bytes as base64. */
interface Reply {
  typeName: string;
  stateJson: string;
  private?: string;
  schemaVersion?: string | number;
}

const objectOf = (r: Reply): ReplayObject => ({
  typeName: r.typeName,
  state: JSON.parse(r.stateJson) as Record<string, unknown>,
  private: r.private ?? "",
  schemaVersion: Number(r.schemaVersion ?? 0),
});
