import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";

/**
 * Anthropic: no operations. Its models are its model half (`model.ts`), which the app's registry
 * names `anthropic/<model-id>`; its driver only declares the key the model half reads.
 */
export const anthropicOps = defineConnector("anthropic", {}, vendorInfo(import.meta.url));
