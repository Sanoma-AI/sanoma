import type { CheckResult } from "@sanoma-ai/workflows";
import type { InferUITools, UIMessage } from "ai";
import type { LoopTools } from "../server/agent/tools.ts";

// The operator agent's chat as the browser and every engine share it: the message type, and the
// parts an engine writes for the chat to draw as cards. Types and plain helpers only.

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
