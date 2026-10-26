import type { Chat, Principal } from "@sanoma-ai/workflows";
import { TypeValidationError, validateUIMessages } from "ai";
import { z } from "zod";
import { ApiError } from "../../api.ts";
import type { AppContext } from "../../context.ts";
import type { ChatMessage } from "../../lib/chat.ts";
import { type ActorContext, parse, requireActor, toApiError } from "../core.ts";
import { run as loop } from "./loop.ts";
import { type Engine, settle, written } from "./transcript.ts";

// A chat turn, whatever engine runs it: the request (the person's one new message, the rest read
// from the transcript) and the engines by name. A turn runs in this process, not as a run: a
// restart loses the turn, not the transcript or the draft, and "continue" picks up.

/** The engines, by the name a chat's row keeps. */
export const ENGINES: Readonly<Record<string, Engine>> = { loop };

/** What the browser sends: the chat's id (its own, for a new chat) and the person's new message. */
const ChatRequest = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/, "a chat id is letters, digits, _ and -"),
  message: z.unknown(),
  /** The engine a new chat opens on; a chat keeps the one it opened on. */
  engine: z.string().default("loop"),
});

/** How to stop each chat's turn under way: a new message to a chat stops its turn first. */
const stops = new Map<string, AbortController>();

/**
 * `POST /api/chat`: a turn of the person's chat. Opens the chat on its first message (the engine
 * the request names, titled by the message), stops a turn of it under way, loads its transcript,
 * settles what a turn a restart cut short left unfinished, validates the messages with the new one
 * last (`validateUIMessages`, a 400 for one it refuses), writes the new one, and answers with its
 * engine's stream. A chat of someone else is a 404.
 */
export async function postChat(request: Request, context: ActorContext & { site?: string }): Promise<Response> {
  const { app } = context;
  if (context.site !== undefined) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const principal = await requireActor(context);
    const body = parse(ChatRequest, await request.json().catch(() => undefined), "The request");
    const { chats } = app.client;
    let chat = await chats.get(body.id);
    if (chat && chat.person !== principal.id) throw new ApiError(404, { error: `No chat ${body.id}` });
    const engine = ENGINES[chat?.engine ?? body.engine];
    if (!engine) throw invalid(`No engine ${body.engine}: the engines are ${Object.keys(ENGINES).join(", ")}`);
    stops.get(body.id)?.abort();
    await written(body.id);
    const history = chat ? await settle(app, await chats.load(body.id)) : [];
    const messages = await validateUIMessages<ChatMessage>({ messages: [...history, body.message] }).catch(
      (err: unknown) => {
        throw TypeValidationError.isInstance(err) ? invalid(`Not a chat message: ${err.message}`) : err;
      },
    );
    const message = messages.at(-1)!;
    if (message.role !== "user") throw invalid("A chat takes the person's messages only");
    if (!chat) {
      const title =
        message.parts
          .find((p) => p.type === "text")
          ?.text.trim()
          .slice(0, 80) || "A chat";
      const opened = { id: body.id, person: principal.id, engine: body.engine, title };
      await chats.open(opened);
      chat = { ...opened, createdAt: Date.now() };
    }
    // The last message as settled, and the new one.
    await chats.upsert(chat.id, [...history.slice(-1), message]);
    const stop = new AbortController();
    stops.set(chat.id, stop);
    const response = await engine({ chat, messages, principal, app, signal: stop.signal });
    const id = chat.id;
    void written(id)?.finally(() => stops.get(id) === stop && stops.delete(id));
    return response;
  } catch (err) {
    const { status, body } = toApiError(err, "a chat turn");
    return Response.json(body, { status });
  }
}

const invalid = (error: string) => new ApiError(400, { error, code: "invalid_input" });

/** The person's chat `id` with its transcript, as stored; null when they have none of that id. */
export async function chatFor(
  { client }: AppContext,
  principal: Principal,
  id: string,
): Promise<{ chat: Chat; messages: ChatMessage[] } | null> {
  const chat = await client.chats.get(id);
  if (chat?.person !== principal.id) return null;
  return { chat, messages: (await client.chats.load(id)) as ChatMessage[] };
}
