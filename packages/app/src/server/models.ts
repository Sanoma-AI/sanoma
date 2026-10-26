import type { ProviderV4 } from "@ai-sdk/provider";
import type { ModelContext, ResolvedConfig } from "@sanoma-ai/workflows";
import { createProviderRegistry } from "ai";
import type { AppContext } from "../context.ts";

/** The models of every connector with a model half, by `<vendor>/<model-id>`, such as `anthropic/default`. */
export type ModelRegistry = ReturnType<typeof createProviderRegistry<Record<string, ProviderV4>, "/">>;

/** Each resolved config's registry, made at its first use. */
const registries = new WeakMap<ResolvedConfig, Promise<ModelRegistry>>();

/**
 * The app's models: one AI SDK registry over the provider each connector's model half makes
 * (`ConnectorSetup.model`), once per resolved config, so `languageModel("anthropic/<model-id>")`
 * resolves, and `<vendor>/default` is the connector's own default. A connector's model reads its
 * key when called, through the client's secrets (the environment's, then the stored ones), so one
 * without a key is in the registry and fails when first called, saying where to set it. A maker
 * that throws fails this call, and the next call tries again.
 */
export function modelRegistry({ resolved, client }: Pick<AppContext, "resolved" | "client">): Promise<ModelRegistry> {
  let registry = registries.get(resolved);
  if (registry) return registry;
  const context: ModelContext = {
    secrets: async (names) => new Map([...(await client.secrets(names))].map(([name, { value }]) => [name, value])),
  };
  registry = Promise.all(
    [...resolved.models].map(async ([vendor, make]) => [vendor, await make(context)] as const),
  ).then((providers) => createProviderRegistry(Object.fromEntries(providers), { separator: "/" }));
  registries.set(resolved, registry);
  registry.catch(() => registries.delete(resolved));
  return registry;
}
