import { withSetup } from "sanoma/workflows";
import { opencodeAgent } from "./agent.ts";
import { opencodeOps } from "./connector.ts";

/** OpenCode (`opencodeAgent`), a coding agent the chat runs on a person's own plan. No operations. */
export const opencode = withSetup(opencodeOps, { agent: opencodeAgent });
