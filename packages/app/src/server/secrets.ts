import type { ModelContext, SanomaClient } from "@sanoma-ai/workflows";

/** Resolves only the deployment's explicit store and bindings. No environment fallback. */
export function secretValues(client: SanomaClient): ModelContext["secrets"] {
  return async (names) => new Map([...(await client.secrets(names))].map(([name, stored]) => [name, stored.value]));
}
