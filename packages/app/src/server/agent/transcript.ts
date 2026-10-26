import type { Chat, Principal } from "@sanoma-ai/workflows";
import { isEnded } from "@sanoma-ai/workflows/shared";
import {
  createUIMessageStreamResponse,
  getToolName,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, heldRunOf, unfinished } from "../../lib/chat.ts";

// What every engine shares of a turn: what it is given, and its reply's stream answered to the
// browser and written to the chat's transcript as it goes (`chatResponse`); and what a turn a
// restart cut short left unfinished, settled before the next (`settle`).

/** What an engine is given for a turn: the chat, its messages (the new one last), who asks, the app, and when to stop. */
export interface EngineTurn {
  chat: Chat;
  messages: ChatMessage[];
  principal: Principal;
  app: AppContext;
  /** Aborted when the person sends another message to the chat before this turn ends. */
  signal: AbortSignal;
}

/** An engine: one turn, answered as a UI message stream (`chatResponse`). */
export type Engine = (turn: EngineTurn) => Promise<Response>;

/** Each chat's transcript writing under way, by chat id. */
const writing = new Map<string, Promise<void>>();

/** The writing of the chat's last reply, while it goes on. */
export const written = (chatId: string): Promise<void> | undefined => writing.get(chatId);

/**
 * The turn's response: `stream` to the browser, and a copy read into the reply's snapshots
 * (`readUIMessageStream`) written to the chat's transcript at each change of
 * shape (a part started or finished, a tool's result, the draft's card) and at its end. Reading
 * the copy keeps the turn going when the browser goes away. A write that fails is logged; the turn
 * goes on.
 */
export function chatResponse(app: AppContext, chat: Chat, stream: ReadableStream<UIMessageChunk>): Response {
  const [browser, copy] = stream.tee();
  const done = (async () => {
    let shape = "";
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream: copy })) {
      last = message;
      const now = shapeOf(message);
      if (now !== shape) {
        shape = now;
        await write(app, chat, message);
      }
    }
    if (last) await write(app, chat, last);
  })().catch((err: unknown) => console.error(`sanoma app: chat ${chat.id}'s transcript could not be written:`, err));
  writing.set(chat.id, done);
  void done.finally(() => writing.get(chat.id) === done && writing.delete(chat.id));
  return createUIMessageStreamResponse({ stream: browser });
}

/** Writes a snapshot of the reply, once it has its id. */
const write = async ({ client }: AppContext, chat: Chat, message: UIMessage) => {
  if (message.id) await client.chats.upsert(chat.id, [message]);
};

/** A snapshot's shape: its parts' kinds and states, and its data parts' contents, but not the text streaming in. */
const shapeOf = (message: UIMessage): string =>
  JSON.stringify(
    message.parts.map((part) =>
      part.type.startsWith("data-")
        ? part
        : [part.type, "state" in part ? part.state : "", "preliminary" in part ? part.preliminary : ""],
    ),
  );

/**
 * The transcript with what a turn left unfinished settled: in any reply, a held lookup's result
 * once its run has ended (still held while it waits); in the last, as a restart cut it short, a
 * tool call with no result failed as interrupted, and text and reasoning done. A message it leaves
 * as it was is the same object, so the caller writes back only those it changed.
 */
export async function settle(app: AppContext, messages: UIMessage[]): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message, i) => {
      if (message.role !== "assistant" || !message.parts.some(unfinished)) return message;
      const last = i === messages.length - 1;
      const parts = await Promise.all(message.parts.map((part) => settlePart(app, part, last)));
      return parts.every((part, j) => part === message.parts[j]) ? message : { ...message, parts };
    }),
  );
}

async function settlePart(
  app: AppContext,
  part: UIMessage["parts"][number],
  last: boolean,
): Promise<UIMessage["parts"][number]> {
  if (!unfinished(part)) return part;
  if (isToolUIPart(part) && part.state === "output-available") {
    const runId = heldRunOf(part.output);
    const run = runId === undefined ? undefined : await app.client.run(runId);
    // Still waiting: held as it was, for a later turn to settle once the run has ended.
    if (run && !isEnded(run.status)) return part;
    if (!run) return { ...part, preliminary: false };
    try {
      return { ...part, preliminary: false, output: { output: await app.client.result(run.runId) } };
    } catch (err) {
      const { preliminary: _, ...rest } = part;
      return { ...rest, state: "output-error", errorText: String((err as Error).message ?? err), output: undefined };
    }
  }
  // Only the last reply can have been cut short; an earlier one's own turn settled it.
  if (!last) return part;
  if (!isToolUIPart(part)) return { ...part, state: "done" } as typeof part;
  if (part.state !== "input-streaming" && part.state !== "input-available") return part;
  return {
    ...part,
    state: "output-error",
    input: part.input ?? {},
    errorText: `${getToolName(part)} was interrupted: the server restarted before it finished`,
  };
}
