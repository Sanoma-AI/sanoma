import { createAnthropic } from "@ai-sdk/anthropic";
import { LoadAPIKeyError, type ProviderV4 } from "@ai-sdk/provider";
import type { ModelContext } from "@sanoma-ai/workflows";
import { customProvider } from "ai";
import { anthropicEnv } from "./driver.ts";

/** The model `anthropic/default` names: the connector's own choice, until a config chooses one. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

const KEY = "ANTHROPIC_API_KEY";

/**
 * Anthropic's models through the AI SDK's adapter (`@ai-sdk/anthropic`), with every model id it
 * knows and `default` for `ANTHROPIC_DEFAULT_MODEL`. The key is read through `secrets` at each
 * request, the environment's first, then the stored one, so a key set on the connector page is
 * used from the next call; without one a call fails with a `LoadAPIKeyError` saying where to set
 * it, and sends nothing.
 */
export function anthropicModel({ secrets }: ModelContext): ProviderV4 {
  const anthropic = createAnthropic({
    // The adapter needs a key when it builds a request's headers; `fetch` puts the real one in.
    apiKey: "read at each request",
    fetch: async (url, init) => {
      const key = (await secrets([KEY])).get(KEY);
      if (!key) {
        const what = anthropicEnv.shape[KEY].description;
        throw new LoadAPIKeyError({
          message: `anthropic is not configured: ${KEY} (${what}); set it on the connector page`,
        });
      }
      const headers = new Headers(init?.headers);
      headers.set("x-api-key", key);
      return fetch(url, { ...init, headers });
    },
  });
  return customProvider({
    languageModels: { default: anthropic.languageModel(ANTHROPIC_DEFAULT_MODEL) },
    fallbackProvider: anthropic,
  });
}
