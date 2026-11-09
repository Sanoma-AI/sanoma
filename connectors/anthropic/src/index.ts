import { withSetup } from "sanoma/workflows";
import { claudeCode } from "./agent.ts";
import { anthropicOps } from "./connector.ts";
import { anthropicDriver } from "./driver.ts";
import { anthropicModel } from "./model.ts";

export { ANTHROPIC_DEFAULT_MODEL } from "./model.ts";

/**
 * Anthropic's models for the app's agent: its model half (`anthropicModel`), which the app's
 * registry names `anthropic/<model-id>` (`anthropic/default` for `ANTHROPIC_DEFAULT_MODEL`), and
 * a driver with no operations that declares `ANTHROPIC_API_KEY`, which the connector page sets.
 * And Claude Code (`claudeCode`), a coding agent the chat runs on a person's own plan or on that key.
 */
export const anthropic = withSetup(anthropicOps, { driver: anthropicDriver, model: anthropicModel, agent: claudeCode });
