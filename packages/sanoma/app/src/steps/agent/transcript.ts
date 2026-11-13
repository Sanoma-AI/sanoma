import type { Chat, ChatTurnContext, SanomaClient } from "sanoma/workflows";
import { isRecord } from "sanoma/workflows/shared";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { ChatMessage } from "../../lib/chat.ts";

// What every engine shares of a turn: what it is given, and its reply's stream written as it goes
// (`persist`): its suggested asks taken out of its text (`suggestedAsks`), then to the chat's
// chunks, which the app streams to the browser, and to its transcript.

/** What an engine is given for a turn: the chat, its messages (the new one last), the id of that new message (`ChatTurnInput.message`, which names the turn), and the turn's step (who asks, when to stop). */
export interface EngineTurn {
  chat: Chat;
  messages: ChatMessage[];
  message: string;
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
 * goes on. Each snapshot records the turn that wrote it, the id of the person's message `turn`, as
 * the reply's metadata `turn` (`turnOf`), which names its catalog calls when `settle` reads the
 * reply later. The reply's message id, once it had one.
 */
export async function persist(
  { client, runId }: ChatTurnContext,
  chat: Chat,
  turn: string,
  stream: ReadableStream<UIMessageChunk>,
): Promise<string | undefined> {
  const [chunks, copy] = suggestedAsks(stream).tee();
  const [, reply] = await Promise.all([
    writeChunks(client, chat, runId, chunks),
    writeTranscript(client, chat, turn, copy),
  ]);
  await client.chats.end(chat.id, runId);
  return reply;
}

/** The line a reply's suggested asks follow, one to a line after it as `- <ask>` (the prompt's rule). */
export const ASKS_LINE = "Suggested asks:";

/** The most asks a reply suggests. */
const MOST_ASKS = 4;

/** The markdown a model may put before `ASKS_LINE` on its line. */
const LEAD = "[\\t #*_]*";
/** `ASKS_LINE` at a line's start, after `LEAD`. */
const ASKS_AT = new RegExp(`(?<=^|\\n)${LEAD}${ASKS_LINE}`, "i");

/** Whether a line could still become `ASKS_LINE` as more of it comes. */
const mayBeAsks = (line: string) =>
  ASKS_LINE.toLowerCase().startsWith(line.replace(new RegExp(`^${LEAD}`), "").toLowerCase());

/** An ask's line: a list item, its text without the bold or quotes around it. */
const ASK = /^\s*(?:[-*•]|\d+[.)])\s+(?:\*\*|["“])?(.+?)(?:\*\*|["”])?\s*$/;

/** A text under way: all of it so far, how much of it was shown, and where its asks' line starts once it came. */
interface Text {
  all: string;
  shown: number;
  asks?: number;
}

/**
 * `stream` with its suggested asks taken out of its text into a `data-suggestions` part (by the id
 * `suggestions`), written as it finishes: a text's list items after a line that is `ASKS_LINE`
 * are the asks, never shown; what it says after them shows as the text ends. The end of a text
 * that may still become that line, and the blank lines before it, are held until it cannot.
 */
export function suggestedAsks(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  const texts = new Map<string, Text>();
  let asks: string[] = [];
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        const text = chunk.type === "text-delta" || chunk.type === "text-end" ? texts.get(chunk.id) : undefined;
        if (chunk.type === "text-start") texts.set(chunk.id, { all: "", shown: 0 });
        else if (chunk.type === "text-delta" && text) {
          const delta = release(text, chunk.delta);
          if (delta) controller.enqueue({ ...chunk, delta });
          return;
        } else if (chunk.type === "text-end" && text) {
          texts.delete(chunk.id);
          let rest = text.all.slice(text.shown);
          if (text.asks !== undefined) ({ asks, rest } = asksIn(text.all.slice(text.asks)));
          if (rest.trim()) controller.enqueue({ type: "text-delta", id: chunk.id, delta: rest.trimEnd() });
        } else if (chunk.type === "finish" && asks.length) {
          controller.enqueue({ type: "data-suggestions", id: "suggestions", data: { asks } });
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** What of a text shows with `delta`: up to its asks' line, or else up to what may still become that line, less the blank lines before it. */
function release(text: Text, delta: string): string {
  // Its asks' line is looked for from the line the delta goes on with, not in the whole text again.
  const from = text.all.lastIndexOf("\n") + 1;
  text.all += delta;
  if (text.asks === undefined) {
    const at = ASKS_AT.exec(text.all.slice(from))?.index;
    if (at !== undefined) text.asks = from + at;
  }
  const line = text.all.lastIndexOf("\n") + 1;
  const end = text.asks ?? (mayBeAsks(text.all.slice(line)) ? line : text.all.length);
  const upTo = text.shown + text.all.slice(text.shown, end).trimEnd().length;
  const shown = text.all.slice(text.shown, upTo);
  text.shown = upTo;
  return shown;
}

/** The asks in a text from its asks' line on, the first `MOST_ASKS` list items, and what it says after them. */
function asksIn(from: string): { asks: string[]; rest: string } {
  const lines = from.split("\n").slice(1);
  // The list ends at the first line, after its first item, that is neither an item nor blank.
  const end = lines.findIndex(
    (line, i) => line.trim() && !ASK.test(line) && lines.slice(0, i).some((l) => ASK.test(l)),
  );
  const items = end === -1 ? lines : lines.slice(0, end);
  const asks = items.flatMap((line) => ASK.exec(line)?.[1] ?? []).slice(0, MOST_ASKS);
  return { asks, rest: end === -1 ? "" : `\n\n${lines.slice(end).join("\n")}` };
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
  turn: string,
  stream: ReadableStream<UIMessageChunk>,
): Promise<string | undefined> {
  let shape = "";
  let last: UIMessage | undefined;
  /** A snapshot of the reply, once it has its id. */
  const write = async (message: UIMessage) => {
    if (!message.id) return;
    const metadata = { ...(isRecord(message.metadata) ? message.metadata : {}), turn };
    await chats.upsert(chat.id, [{ ...message, metadata }]);
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
