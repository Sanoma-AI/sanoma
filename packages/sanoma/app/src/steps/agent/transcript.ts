import type { Chat, ChatTurnContext, SanomaClient } from "sanoma/workflows";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { ChatMessage } from "../../lib/chat.ts";

// What every engine shares of a turn: what it is given, and its reply's stream written as it goes
// (`persist`): to the chat's chunks, which the app streams to the browser, and to its transcript.

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
 * Writes the turn's reply, `stream`: its chunks to the chat's (`Chats.append`, in batches), and its
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
  const [chunks, copy] = stream.tee();
  const [, reply] = await Promise.all([writeChunks(client, chat, runId, chunks), writeTranscript(client, chat, copy)]);
  await client.chats.end(chat.id, runId);
  return reply;
}

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
