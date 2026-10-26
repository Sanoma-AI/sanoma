import type { CheckResult } from "@sanoma-ai/workflows";
import { DefaultChatTransport, type InferUITools, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import type { LoopTools } from "../server/agent/tools.ts";

// The operator agent's chat as the browser and every engine share it: the message type, the
// parts an engine writes for the chat to draw as cards, and the browser's transport. No server code.

/**
 * The draft card's data, the `data-draft` part an engine writes (one per reply, by the id
 * `draft`, updated in place) whenever the chat's draft changes: its branch, its committed change
 * (`Source.diff`) and, once it ran, the checks since the last edit.
 */
export interface DraftCard {
  branch: string;
  files: string[];
  summary: string;
  checks?: CheckResult;
}

/**
 * The engines a chat can open on, by the name its row keeps, with the name the chat shows: our
 * loop, or an existing coding agent through `HarnessAgent` on the company's key.
 */
export const ENGINE_NAMES = { loop: "Sanoma", pi: "Pi", "claude-code": "Claude Code" } as const;

/** An engine's name, as a chat's row keeps it. */
export type EngineName = keyof typeof ENGINE_NAMES;

/** The data parts of a chat message, by name: `data-<name>`. */
export type ChatData = { draft: DraftCard };

/**
 * A message of the operator agent's chat: our loop's tools typed (`InferAgentUIMessage` of its
 * agent, with the data parts), another engine's tools as `dynamic-tool` parts.
 */
export type ChatMessage = UIMessage<unknown, ChatData, InferUITools<LoopTools>>;

/**
 * The output a lookup the policy holds shows until it is decided, as any engine writes it: a tool
 * part whose output is `{ held: { runId } }`, which the chat draws as the approval's card.
 */
export interface HeldOutput {
  held: { runId: string };
}

/** The held call's run, when a tool part's output is a held lookup's. */
export const heldRunOf = (output: unknown): string | undefined => {
  const runId = (output as Partial<HeldOutput> | null | undefined)?.held?.runId;
  return typeof runId === "string" ? runId : undefined;
};

/** What a turn's error says when the model's connector has no key: its message, then its connector's page. */
export const noKeyText = (vendor: string, message: string) => `${message} [connector:${vendor}]`;

/** The connector whose page a turn's error text points to (`noKeyText`), and the text without it. */
export function errorParts(text: string): { text: string; vendor?: string } {
  const found = / \[connector:([\w-]+)\]$/.exec(text);
  return found ? { text: text.slice(0, found.index), vendor: found[1]! } : { text };
}

/** A message's text, its text parts joined by `separator`. */
export const textOf = (message: UIMessage, separator = "\n\n") =>
  message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join(separator);

/**
 * A part a turn left under way: text still streaming, a tool call without its result, or a held
 * lookup's preliminary output. The chat offers Continue after one; the server settles it (`settle`).
 */
export const unfinished = (part: UIMessage["parts"][number]): boolean =>
  isToolUIPart(part)
    ? part.state === "input-streaming" ||
      part.state === "input-available" ||
      (part.state === "output-available" && part.preliminary === true)
    : (part.type === "text" || part.type === "reasoning") && part.state === "streaming";

/**
 * The chat's transport to `POST /api/chat` (`api`), as the chat column makes it: only the new
 * message is sent, the server reading the rest from the chat's transcript, with the engine a new
 * chat opens on when the send names one (`sendMessage(message, { body: { engine } })`; a chat
 * keeps the one it opened on).
 */
export const chatTransport = (api: string, headers: () => Record<string, string>) =>
  new DefaultChatTransport<ChatMessage>({
    api,
    headers,
    prepareSendMessagesRequest: ({ id, messages, body }) => ({
      body: { id, message: messages.at(-1), ...(body?.engine !== undefined && { engine: body.engine }) },
    }),
  });
