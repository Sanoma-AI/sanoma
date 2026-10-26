import { defineDriver } from "@sanoma-ai/workflows";
import { z } from "zod";
import { anthropicOps } from "./connector.ts";

/** The environment variable the model half reads, at each call: declared here, so the connector page asks for it. */
export const anthropicEnv = z.object({
  ANTHROPIC_API_KEY: z.string().describe("an API key, from the API Keys page of the Claude Console"),
});

/** No operations to implement: the driver carries the key's declaration for the connector page and stored credentials. */
export const anthropicDriver = () => defineDriver(anthropicOps, {}, { env: anthropicEnv });
