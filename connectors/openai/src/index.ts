import { withSetup } from "sanoma/workflows";
import { codex } from "./agent.ts";
import { openaiOps } from "./connector.ts";

/** OpenAI's Codex (`codex`), a coding agent the chat runs on a person's own plan. No operations or models yet. */
export const openai = withSetup(openaiOps, { agent: codex });
