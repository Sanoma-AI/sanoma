import { defineConnector, vendorInfo } from "sanoma/workflows";

/** OpenAI: no operations yet. Its coding agent, Codex, is its agent part (`agent.ts`). */
export const openaiOps = defineConnector("openai", {}, vendorInfo(import.meta.url));
