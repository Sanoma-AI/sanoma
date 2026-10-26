import type { Chat, Principal } from "@sanoma-ai/workflows";
import { safeValidateUIMessages } from "ai";
import { z } from "zod";
import { ApiError } from "../../api.ts";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, type EngineName, textOf } from "../../lib/chat.ts";
import { type ActorContext, parse, requireActor, toApiError } from "../core.ts";
import { acpEngine } from "./acp.ts";
import { harnessEngine } from "./harness.ts";
import { run as loop } from "./loop.ts";
import { type Engine, settle, written } from "./transcript.ts";

// A chat turn, whatever engine runs it: the request (the person's one new message, the rest read
// from the transcript) and the engines by name. A turn runs in this process, not as a run: a
// restart loses the turn, not the transcript or the draft, and "continue" picks up.

/**
 * The engines, by the name a chat's row keeps (`ENGINE_NAMES`): our loop, the coding agents through
 * `HarnessAgent` on the company's key, and a person's own over ACP.
 */
export const ENGINES: Readonly<Record<EngineName, Engine>> = {
  loop,
  pi: harnessEngine("pi"),
  "claude-code": harnessEngine("claude-code"),
  "acp-copilot": acpEngine("copilot"),
  "acp-opencode": acpEngine("opencode"),
  "acp-pi": acpEngine("pi"),
  "acp-claude-code": acpEngine("claude-code"),
  "acp-codex": acpEngine("codex"),
};

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
 * `POST /api/chat`: a turn of the person's chat. Validates the new message (`safeValidateUIMessages`,
 * a 400 for one it refuses, or one the chat has already), opens the chat on its first message
 * (the engine the request names, titled by the message), stops a turn of it under way, loads its
 * transcript and settles what a turn a restart cut short left unfinished, writes the new message,
 * and answers with its engine's stream. A chat of someone else is a 404.
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
    const named = chat?.engine ?? body.engine;
    if (!Object.hasOwn(ENGINES, named)) {
      throw invalid(`No engine ${named}: the engines are ${Object.keys(ENGINES).join(", ")}`);
    }
    const engine = ENGINES[named as EngineName];
    // The new message is checked before a turn under way is stopped for it: a new one, by the
    // person. The transcript, written by this app, is not validated again.
    const checked = await safeValidateUIMessages<ChatMessage>({ messages: [body.message] });
    if (!checked.success) throw invalid(`Not a chat message: ${checked.error.message}`);
    const message = checked.data[0]!;
    if (message.role !== "user" || !message.parts.every((part) => part.type === "text")) {
      throw invalid("A chat takes the person's messages, as text");
    }
    const load = async () => (chat ? await chats.load(chat.id) : []);
    if ((await load()).some((m) => m.id === message.id)) throw invalid(`The chat has a message ${message.id} already`);
    stops.get(body.id)?.abort();
    await written(body.id);
    // Read once the turn stopped has written its reply.
    const stored = await load();
    const history = (await settle(app, stored)) as ChatMessage[];
    const messages = [...history, message];
    if (!chat) {
      const title = textOf(message, " ").trim().slice(0, 80) || "A chat";
      const opened = { id: body.id, person: principal.id, engine: body.engine, title };
      await chats.open(opened);
      chat = { ...opened, createdAt: Date.now() };
    }
    // The messages settle changed, and the new one.
    await chats.upsert(chat.id, [...history.filter((m, i) => m !== stored[i]), message]);
    const stop = new AbortController();
    stops.set(chat.id, stop);
    const response = await engine({ chat, messages, principal, app, signal: stop.signal });
    const id = chat.id;
    const forget = () => stops.get(id) === stop && stops.delete(id);
    const replying = written(id);
    if (replying) void replying.finally(forget);
    else forget();
    return response;
  } catch (err) {
    const { status, body } = toApiError(err, "a chat turn");
    return Response.json(body, { status });
  }
}

const invalid = (error: string) => new ApiError(400, { error, code: "invalid_input" });

/** The person's chat `id` with its transcript; null when they have none of that id. */
export async function chatFor(
  app: AppContext,
  principal: Principal,
  id: string,
): Promise<{ chat: Chat; messages: ChatMessage[] } | null> {
  const { client } = app;
  const chat = await client.chats.get(id);
  if (chat?.person !== principal.id) return null;
  // As the next turn will take it: what a restart cut short settled, unless a turn is under way.
  const stored = await client.chats.load(id);
  return { chat, messages: (written(id) ? stored : await settle(app, stored)) as ChatMessage[] };
}
