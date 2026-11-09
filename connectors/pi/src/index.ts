import { withSetup } from "sanoma/workflows";
import { piAgent } from "./agent.ts";
import { piOps } from "./connector.ts";

/** Pi (`piAgent`), a coding agent the chat runs on a person's own plan or on the company's Anthropic key. No operations. */
export const pi = withSetup(piOps, { agent: piAgent });
