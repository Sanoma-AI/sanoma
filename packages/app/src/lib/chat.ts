import type { CheckResult } from "@sanoma-ai/workflows";
import { DefaultChatTransport, type InferUITools, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import type { LoopTools } from "../server/agent/tools.ts";

// The operator agent's chat as the browser and every engine share it: the message type, the
// parts an engine writes for the chat to draw as cards, and the browser's transport. No server code.

/**
 * The draft card's data, the `data-draft` part an engine writes (one per reply, by the id
 * `draft`, updated in place) whenever the chat's draft changes: the draft's id (its branch's
 * `draft/<id>`, the chat's id; every engine writes it, but a card saved before it did lacks it),
 * its branch, its committed change (`Source.diff`) and, once it ran, the checks since the last edit.
 */
export interface DraftCard {
  draft?: string;
  branch: string;
  files: string[];
  summary: string;
  checks?: CheckResult;
}

/**
 * A sign-in card's data, the `data-signIn` part a person's own agent writes (by the id `sign-in`,
 * updated in place) when its vendor asks the person to sign in: `waiting` with what the vendor
 * printed or said (its link, `url`, and its code among it; `asks` when it wants a code pasted
 * back), then `done` or `failed`; or `once`, the command to run once on this computer, for a
 * vendor whose sign-in needs a real terminal. The sign-in is the person's: the app never opens the
 * link or enters the code, and the card keeps neither once it ends.
 */
export interface SignInCard {
  /** The vendor's name for its agent. */
  agent: string;
  state: "waiting" | "done" | "failed" | "once";
  text?: string;
  url?: string;
  asks?: boolean;
  command?: string;
  /** What to do in the command's own terminal once it starts, for `once`. */
  after?: string;
}

/**
 * The engines a chat can open on, by the name its row keeps, with the name the chat shows: our
 * loop, an existing coding agent through `HarnessAgent` on the company's key, or a person's own
 * coding agent over ACP on their own plan (`acp-<agent>`, `ownPlan`).
 */
export const ENGINE_NAMES = {
  loop: "Sanoma",
  pi: "Pi",
  "claude-code": "Claude Code",
  "acp-copilot": "Copilot (your plan)",
  "acp-opencode": "OpenCode (your plan)",
  "acp-pi": "Pi (your plan)",
  "acp-claude-code": "Claude Code (your plan)",
  "acp-codex": "Codex (your plan)",
} as const;

/** Whether an engine spends the person's own plan: their own agent over ACP. */
export const ownPlan = (engine: string) => engine.startsWith("acp-");

/** Whether an engine answers on the company's model connector (`chatModel`): our loop; a coding agent says what it lacks itself. */
export const onModelConnector = (engine: string) => engine === "loop";

/** The connector a company without a model adds: Anthropic's, which the template installs. */
export const MODEL_CONNECTOR = "@sanoma-ai/connector-anthropic";

/** The file a coding agent's built-in call names: the cross-harness `file_path`, or an adapter's own field. */
export function pathOf(input: unknown): string | undefined {
  const fields = (input ?? {}) as Record<string, unknown>;
  const path = [fields.file_path, fields.path, fields.notebook_path].find((value) => typeof value === "string");
  return path as string | undefined;
}

/** An engine's name, as a chat's row keeps it. */
export type EngineName = keyof typeof ENGINE_NAMES;

/** The data parts of a chat message, by name: `data-<name>`. */
export type ChatData = { draft: DraftCard; signIn: SignInCard };

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

/** Why a turn of the loop is refused while it has no model (`chatModel`): with its connector's page (`noKeyText`), when there is one. */
export const noModelText = (vendor?: string) =>
  vendor
    ? noKeyText(vendor, `Connect a model to start: ${vendor} is not configured`)
    : `Connect a model to start: add a connector with a model, such as ${MODEL_CONNECTOR}`;

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
      body: { id, message: messages.at(-1), engine: body?.engine },
    }),
  });
