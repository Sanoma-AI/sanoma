import { defineDriver, DriverError, type DriverFn } from "@sanoma/workflows";
import { fromTfState, type TfResourceType, toTfState } from "@sanoma/bridge/tfschema";
import { type BridgeLike, type BridgeResource, bridgeErrorOf } from "./bridge.ts";
import { stripe } from "./index.ts";
import { provider, stripe_product, stripe_webhook_endpoint } from "./resources.gen.ts";

export type { BridgeLike, Diagnostic, ProviderRef } from "./bridge.ts";

/** Each resource type's provider type, by the connector's name for it. */
export const TYPES = {
  product: stripe_product,
  webhook_endpoint: stripe_webhook_endpoint,
} as const satisfies Record<string, TfResourceType>;

export interface StripeDriverOptions {
  /** The provider bridge, started by the config (`startBridge`). One per tenant: it holds the key once configured. */
  bridge: BridgeLike;
}

/**
 * Reads Stripe resources through the `stripe/stripe` OpenTofu provider on `bridge`, with the
 * secret key in `STRIPE_API_KEY`, read on every call. The provider is configured on the first
 * call, and again when the key changes or the provider has exited.
 */
export function stripeDriver(options: StripeDriverOptions) {
  return defineDriver(
    stripe,
    stripeOps(options.bridge, () => {
      const key = process.env.STRIPE_API_KEY;
      if (!key) throw new DriverError("stripe: STRIPE_API_KEY is not set", { retryable: false });
      return { api_key: key, stripe_account: null };
    }),
  );
}

/** The driver's operations over `bridge`, configuring the provider with what `config` returns. The fake passes its own. */
export function stripeOps(bridge: BridgeLike, config: () => Record<string, unknown>) {
  const ops = bridgedOps("stripe", bridge, config);
  return {
    product: ops(TYPES.product),
    webhook_endpoint: ops(TYPES.webhook_endpoint),
  };
}

/**
 * `import` and `read` for a provider's resource types over the bridge. `import` asks the
 * provider to find the object by its import id (it reads it too). `read` refreshes a state
 * from an earlier call, or, given none, imports first and reads what the import returned.
 * States go out in the resource's shape, with secrets dropped (`fromTfState`), and come back
 * in the provider's (`toTfState`).
 */
function bridgedOps(vendor: string, bridge: BridgeLike, config: () => Record<string, unknown>) {
  let configured: { config: string; done: Promise<unknown> } | undefined;

  async function configure() {
    const json = JSON.stringify(config());
    if (configured?.config !== json) {
      // The bridge refuses another config for a configured provider until it is closed.
      if (configured) {
        configured = undefined;
        await bridge.close(provider);
      }
      const done = bridge.configure(provider, json);
      configured = { config: json, done };
      done.catch(() => {
        if (configured?.done === done) configured = undefined;
      });
    }
    await configured.done;
  }

  /** Runs `fn` on a configured provider, with the bridge's errors as `DriverError`s. */
  async function call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      await configure();
      return await fn();
    } catch (e) {
      const err = bridgeErrorOf(e);
      if (!err) throw e;
      // The provider process failed or exited: configure it again on the next try.
      if (err.code === "unavailable") configured = undefined;
      const said = err.diagnostics.map((d) => (d.detail ? `${d.summary}: ${d.detail}` : d.summary)).join("; ");
      throw new DriverError(`${vendor}: ${op} failed (${err.code}): ${said || err.message}`, {
        retryable: err.code === "unavailable",
        vendorCode: err.code,
        cause: e,
      });
    }
  }

  return (type: TfResourceType) => {
    const op = (name: string) => `${type.typeName.replace(`${vendor}_`, "")}.${name}`;
    const importOne = async (id: string): Promise<BridgeResource> => {
      const { resources } = await bridge.import(provider, type.typeName, id);
      const found = resources.find((r) => r.typeName === type.typeName);
      if (found) return found;
      throw new DriverError(`${vendor}: ${op("import")} found no ${type.typeName} "${id}"`, {
        retryable: false,
        vendorCode: "not_found",
      });
    };
    const out = (r: BridgeResource) => ({
      state: fromTfState(type.shape, JSON.parse(r.stateJson) as Record<string, unknown>),
      handle: `${r.schemaVersion}:${Buffer.from(r.private).toString("base64")}`,
    });

    const importOp: DriverFn<any, any> = ({ id }: { id: string }) =>
      call(op("import"), async () => ({ id, ...out(await importOne(id)) }));

    const readOp: DriverFn<any, any> = (input: { id: string; state?: Record<string, unknown>; handle?: string }) =>
      call(op("read"), async () => {
        const [version, priv = ""] = input.handle?.split(":") ?? [];
        const from: Omit<BridgeResource, "typeName"> = input.state
          ? {
              stateJson: JSON.stringify(toTfState(type.shape, input.state)),
              private: Buffer.from(priv, "base64"),
              schemaVersion: version ? Number(version) : type.schemaVersion,
            }
          : await importOne(input.id);
        const reply = await bridge.read(provider, type.typeName, from.stateJson, from.private, from.schemaVersion);
        if (reply.gone || !reply.resource) return { id: input.id, gone: true };
        return { id: input.id, gone: false, ...out(reply.resource) };
      });

    return { import: importOp, read: readOp };
  };
}
