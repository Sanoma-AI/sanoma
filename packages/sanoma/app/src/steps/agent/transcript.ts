import type { Chat, ChatTurnContext, SanomaClient } from "sanoma/workflows";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { ChatMessage } from "../../lib/chat.ts";

// What every engine shares of a turn: what it is given, and its reply's stream written as it goes
// (`persist`): its suggested asks taken out of its text (`suggestedAsks`), then to the chat's
// chunks, which the app streams to the browser, and to its transcript.

/** What an engine is given for a turn: the chat, its messages (the new one last), and the turn's step (who asks, when to stop). */
export interface EngineTurn {
  chat: Chat;
  messages: ChatMessage[];
  step: ChatTurnContext;
}

/** An engine: one turn, as a UI message stream (`createUIMessageStream`), which `persist` writes. */
export type Engine = (turn: EngineTurn) => ReadableStream<UIMessageChunk>;

/** How long chunks gather before they are written as one batch, in ms: the browser's stream lags by about this much. */
const BATCH_MS = 50;

/**
 * Writes the turn's reply, `stream`, with its suggested asks as a card (`suggestedAsks`): its chunks to the chat's (`Chats.append`, in batches), and its
 * snapshots (`readUIMessageStream`) to the chat's transcript at each change of shape (a part
 * started or finished, a tool's result, the draft's card) and at its end; then ends the chunks
 * (`Chats.end`), once the transcript has the whole reply. A write that fails is logged; the turn
 * goes on. The reply's message id, once it had one.
 */
export async function persist(
  { client, runId }: ChatTurnContext,
  chat: Chat,
  stream: ReadableStream<UIMessageChunk>,
): Promise<string | undefined> {
  const [chunks, copy] = suggestedAsks(stream).tee();
  const [, reply] = await Promise.all([writeChunks(client, chat, runId, chunks), writeTranscript(client, chat, copy)]);
  await client.chats.end(chat.id, runId);
  return reply;
}

/** The line a reply's suggested asks follow, one to a line after it as `- <ask>` (the prompt's rule). */
export const ASKS_LINE = "Suggested asks:";

/** The most asks a reply suggests. */
const MOST_ASKS = 4;

/** `ASKS_LINE` at a line's start, after any markdown the model put before it. */
const ASKS_AT = /(?<=^|\n)[\t #*_]*suggested asks:/i;

/** Whether a line could still become `ASKS_LINE` as more of it comes. */
const mayBeAsks = (line: string) => ASKS_LINE.toLowerCase().startsWith(line.replace(/^[\t #*_]*/, "").toLowerCase());

/** An ask's line: a list item, its text without the bold or quotes around it. */
const ASK = /^\s*(?:[-*•]|\d+[.)])\s+(?:\*\*|["“])?(.+?)(?:\*\*|["”])?\s*$/;

/**
 * `stream` with its suggested asks taken out of its text into a `data-suggestions` part (by the id
 * `suggestions`), written as it finishes: a text's lines from one that is `ASKS_LINE` on are held
 * back, and their list items are the asks. The end of a text that may still become that line, and
 * the blank lines before it, are held until it cannot, so the asks never show as text.
 */
export function suggestedAsks(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  /** Each text under way, by id: what is held back of it, and its asks' lines once they began. */
  const texts = new Map<string, { held: string; asks?: string }>();
  let asks: string[] = [];
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "text-start") texts.set(chunk.id, { held: "" });
        else if (chunk.type === "text-delta" && texts.has(chunk.id)) {
          const shown = release(texts.get(chunk.id)!, chunk.delta);
          if (shown) controller.enqueue({ ...chunk, delta: shown });
          return;
        } else if (chunk.type === "text-end" && texts.has(chunk.id)) {
          const { held, asks: lines } = texts.get(chunk.id)!;
          texts.delete(chunk.id);
          if (lines !== undefined) asks = asksIn(lines);
          else if (held.trim()) controller.enqueue({ type: "text-delta", id: chunk.id, delta: held.trimEnd() });
        } else if (chunk.type === "finish" && asks.length) {
          controller.enqueue({ type: "data-suggestions", id: "suggestions", data: { asks } });
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * What of a text's `delta` shows now: up to its asks' line, or else up to what may still become
 * that line, or the blank lines before it, which stay held.
 */
function release(text: { held: string; asks?: string }, delta: string): string {
  if (text.asks !== undefined) {
    text.asks += delta;
    return "";
  }
  const all = text.held + delta;
  const found = ASKS_AT.exec(all);
  if (found) {
    text.asks = all.slice(found.index);
    text.held = "";
    return all.slice(0, found.index).trimEnd();
  }
  const line = all.lastIndexOf("\n") + 1;
  const shown = all.slice(0, mayBeAsks(all.slice(line)) ? line : all.length).trimEnd();
  text.held = all.slice(shown.length);
  return shown;
}

/** The asks in the lines from `ASKS_LINE` on: its list items, the first `MOST_ASKS`. */
const asksIn = (lines: string): string[] =>
  lines
    .split("\n")
    .slice(1)
    .flatMap((line) => ASK.exec(line)?.[1] ?? [])
    .slice(0, MOST_ASKS);

async function writeChunks(client: SanomaClient, chat: Chat, turn: string, stream: ReadableStream<UIMessageChunk>) {
  let batch: UIMessageChunk[] = [];
  let writing = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const chunks = batch;
    batch = [];
    writing = writing
      .then(() => client.chats.append(chat.id, turn, chunks))
      .catch((err: unknown) => console.error(`sanoma app: chat ${chat.id}'s reply could not be streamed:`, err));
  };
  for await (const chunk of stream) {
    batch.push(chunk);
    timer ??= setTimeout(flush, BATCH_MS);
  }
  flush();
  await writing;
}

async function writeTranscript(
  { chats }: SanomaClient,
  chat: Chat,
  stream: ReadableStream<UIMessageChunk>,
): Promise<string | undefined> {
  let shape = "";
  let last: UIMessage | undefined;
  /** A snapshot of the reply, once it has its id. */
  const write = async (message: UIMessage) => {
    if (message.id) await chats.upsert(chat.id, [message]);
  };
  try {
    for await (const message of readUIMessageStream({ stream })) {
      last = message;
      const now = shapeOf(message);
      if (now !== shape) {
        shape = now;
        await write(message);
      }
    }
    if (last) await write(last);
  } catch (err) {
    console.error(`sanoma app: chat ${chat.id}'s transcript could not be written:`, err);
  }
  return last?.id || undefined;
}

/** A snapshot's shape: its parts' kinds and states, and its data parts' contents, but not the text streaming in. */
const shapeOf = (message: UIMessage): string =>
  JSON.stringify(
    message.parts.map((part) =>
      part.type.startsWith("data-")
        ? part
        : [part.type, "state" in part ? part.state : "", "preliminary" in part ? part.preliminary : ""],
    ),
  );
