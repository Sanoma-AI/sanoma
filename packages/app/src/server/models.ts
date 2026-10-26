import type { ProviderV4 } from "@ai-sdk/provider";
import type { ResolvedConfig, SanomaClient } from "@sanoma-ai/workflows";
import { createProviderRegistry } from "ai";
import type { AppContext } from "../context.ts";
import { secretValues } from "./secrets.ts";

/** The models of every connector with a model half, by `<vendor>/<model-id>`, such as `anthropic/default`. */
export type ModelRegistry = ReturnType<typeof createProviderRegistry<Record<string, ProviderV4>, "/">>;

/** Each resolved config's registry, for the client its keys are read through, made at its first use. */
const registries = new WeakMap<ResolvedConfig, WeakMap<SanomaClient, Promise<ModelRegistry>>>();

/**
 * The app's models: one AI SDK registry over the provider each connector's model half makes
 * (`ConnectorSetup.model`), once per resolved config, so `languageModel("anthropic/<model-id>")`
 * resolves, and `<vendor>/default` is the connector's own default. A connector's model reads its
 * key when called (`secretValues`: the environment's, then the stored one), so one without a key
 * is in the registry and fails when first called, saying where to set it. A maker that throws
 * fails this call, and the next call tries again.
 */
export function modelRegistry({ resolved, client }: Pick<AppContext, "resolved" | "client">): Promise<ModelRegistry> {
  let byClient = registries.get(resolved);
  if (!byClient) registries.set(resolved, (byClient = new WeakMap()));
  let registry = byClient.get(client);
  if (registry) return registry;
  const context = { secrets: secretValues(client) };
  registry = Promise.all(
    [...resolved.models].map(async ([vendor, make]) => [vendor, await make(context)] as const),
  ).then((providers) => createProviderRegistry(Object.fromEntries(providers), { separator: "/" }));
  byClient.set(client, registry);
  registry.catch(() => byClient.delete(client));
  return registry;
}
