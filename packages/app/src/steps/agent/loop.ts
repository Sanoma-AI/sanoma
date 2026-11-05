import {
  AISDKError,
  createAgentUIStream,
  createUIMessageStream,
  generateId,
  isStepCount,
  LoadAPIKeyError,
  type LanguageModel,
  pruneMessages,
  type StopCondition,
  ToolLoopAgent,
} from "ai";
import { noKeyText } from "../../lib/chat.ts";
import { modelRegistry, modelVendor } from "../../server/models.ts";
import { instructions } from "./prompt.ts";
import { type LoopTools, loopTools } from "./tools.ts";
import type { Engine } from "./transcript.ts";

// Our own loop, the chat's first engine: the AI SDK's ToolLoopAgent on the company's model (the
// first connector with a model half, its default), with our tools on the chat's draft.

/** The most steps (model calls) in a turn. */
const MAX_STEPS = 50;
/** The most tokens a turn may spend, every step's input and output together, before it stops. */
const TURN_TOKENS = 1_000_000;

/** Stops a turn once its steps have used `limit` tokens. */
const tokensOver =
  (limit: number): StopCondition<LoopTools> =>
  ({ steps }) =>
    steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0) >= limit;

/** The loop's agent on `model`, told `system`, with `tools`. */
const loopAgent = (model: LanguageModel, system: string, tools: LoopTools) =>
  new ToolLoopAgent({
    model,
    instructions: system,
    tools,
    stopWhen: [isStepCount(MAX_STEPS), tokensOver(TURN_TOKENS)],
    // The context kept: earlier tool calls' results and reasoning go once they are well behind.
    prepareStep: ({ messages }) => ({
      messages: pruneMessages({ messages, reasoning: "before-last-message", toolCalls: "before-last-40-messages" }),
    }),
  });

/** The loop's engine: a turn of `chat` as a UI message stream. */
export const run: Engine = ({ chat, messages, step }) => {
  // `postChat` refuses a turn of the loop (`onModelConnector`) while no connector gives a model (`chatModel`).
  const vendor = modelVendor(step)!;
  const { by: principal, signal } = step;
  /** What the chat says for a failure: a missing key with its connector's page; the AI SDK's own errors as they are. */
  const onError = (err: unknown): string => {
    if (LoadAPIKeyError.isInstance(err)) return noKeyText(vendor, err.message);
    if (AISDKError.isInstance(err)) return err.message;
    console.error("sanoma app: a chat turn failed:", err);
    return "Something went wrong; the server's log says what";
  };
  return createUIMessageStream({
    onError,
    execute: async ({ writer }) => {
      const [registry, system] = await Promise.all([modelRegistry(step), instructions(step, principal, chat)]);
      const model = registry.languageModel(`${vendor}/default`);
      const tools = loopTools({
        step,
        chat,
        showDraft: (data) => writer.write({ type: "data-draft", id: "draft", data }),
      });
      const agent = loopAgent(model, system, tools);
      writer.merge(
        await createAgentUIStream({
          agent,
          uiMessages: messages,
          abortSignal: signal,
          generateMessageId: generateId,
          onError,
        }),
      );
    },
  });
};
