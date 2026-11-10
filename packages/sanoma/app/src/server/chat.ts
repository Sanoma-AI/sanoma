import { type Chat, ChatTurnInput, type Principal, type SanomaClient } from "sanoma/workflows";
import { isEnded } from "sanoma/workflows/shared";
import {
  createUIMessageStreamResponse,
  getToolName,
  isToolUIPart,
  safeValidateUIMessages,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import { ApiError } from "../api.ts";
import type { AppContext } from "../context.ts";
import {
  type ChatMessage,
  engineOf,
  heldRunOf,
  NO_BOX,
  noModelText,
  onModelConnector,
  textOf,
  unfinished,
  written,
} from "../lib/chat.ts";
import { type ActorContext, parse, requireActor, toApiError } from "./core.ts";
import { chatModel } from "./models.ts";

// The operator agent's chat, as the app answers it: a turn is a run of the built-in `chat`, which
// the worker runs (`sanoma/app/steps`' `chat`, with the engines), writing the reply's chunks
// and the transcript to the database. The app checks the message, opens the chat, writes the
// message to its transcript, starts the turn (`SanomaClient.startTurn`, which tells a turn under
// way to stop) and streams the chunks back as the worker writes them; a code pasted on a sign-in
// card goes to the run as a message. A chat may begin with the agent speaking first (`start`).

/** A person's message, as a chat takes it: its id (the browser's, which names the turn's run) and its text. */
const PersonMessage = z.object({
  id: ChatTurnInput.shape.message,
  role: z.literal("user"),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

/** What the browser sends: the chat's id (its own, for a new chat) and the person's new message, or with `start` the agent's cue. */
const ChatRequest = z.object({
  id: ChatTurnInput.shape.chat,
  message: z.unknown(),
  /** The engine a new chat opens on; a chat keeps the one it opened on. */
  engine: z.string().default("loop"),
  /** The agent speaks first, in a chat the person has not written in yet: the message is its cue, whose text is `INTRO`. */
  start: z.literal(true).optional(),
});

/** What the agent is asked when it speaks first: the text of the turn's message, which the chat never shows (`isIntro`). */
export const INTRO =
  "Introduce yourself to me in a few plain sentences: that you make the changes to this company when I ask, and what you read in it (its workflows, connectors and people). Then suggest up to four things I could ask you first, for a business like this one.";

/**
 * How soon the reply's stream looks again for the chunks the worker writes, in ms: `POLL_MS` while
 * they come, twice as long after each look that found none, up to `QUIET_MS` (a turn may wait a
 * day for its person's sign-in).
 */
const POLL_MS = 100;
const QUIET_MS = 2_000;
/** How often, while no chunk comes, it asks whether the turn's run has ended, in ms. */
const STATUS_MS = 2_000;

/**
 * `POST /api/chat`: a turn of the person's chat. Validates the new message (`safeValidateUIMessages`,
 * a 400 for one it refuses, or one the chat has already), opens the chat on its first message
 * (the engine the request names, titled by the message), writes the message to its transcript
 * (so a turn that fails keeps it), starts the turn's run on its id and answers with
 * the reply's stream, read from the database as the worker writes it (`replyStream`). A chat of
 * someone else is a 404; a turn of the loop while it has no model (`chatModel`), a 409 before
 * the chat opens. A `start` is the agent speaking first: the message sent is its cue, written as
 * `INTRO` and marked (`isIntro`), in a new chat titled "Getting started" or one with no message of
 * the person's yet (a sign-in it asked for has just finished, say), a 400 otherwise; and never
 * while the loop has no model.
 */
export async function postChat(request: Request, context: ActorContext & { site?: string }): Promise<Response> {
  const { app } = context;
  if (context.site !== undefined) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const principal = await requireActor(context);
    const body = parse(ChatRequest, await request.json().catch(() => undefined), "The request");
    const { chats } = app.client;
    const chat = await chats.get(body.id);
    if (chat && chat.person !== principal.id) throw new ApiError(404, { error: `No chat ${body.id}` });
    // A chat keeps its engine, whose turn says what it lacks; a new one opens only on one it can run here.
    if (!chat) await checkEngine(app, body.engine);
    const named = chat?.engine ?? body.engine;
    const sent = await personMessage(body.message);
    const message: ChatMessage = body.start
      ? { ...sent, parts: [{ type: "text", text: INTRO }], metadata: { intro: true } }
      : sent;
    const [had, wrote, model] = await Promise.all([
      chat ? chats.has(chat.id, message.id) : false,
      chat && body.start ? app.client.chats.load(chat.id).then(written) : false,
      onModelConnector(named) ? chatModel(app) : undefined,
    ]);
    if (had) throw invalid(`The chat has a message ${message.id} already`);
    if (wrote) throw invalid("The agent speaks first only in a chat you have not written in");
    // A valid message the loop cannot answer yet: refused before the chat opens, as the composer says.
    if (model && !model.ready) throw new ApiError(409, { error: noModelText(model.vendor) });
    if (!chat) {
      const title = body.start ? "Getting started" : textOf(message, " ").trim().slice(0, 80) || "A chat";
      await chats.open({ id: body.id, person: principal.id, engine: body.engine, title });
    }
    // In the transcript before the turn starts, so a turn that fails at once keeps it; the run is
    // given its id only, since a run's input is in the ledger the company's staff read.
    await chats.upsert(body.id, [message]);
    const runId = await app.client.startTurn({ chat: body.id, message: message.id }, { startedBy: principal });
    return createUIMessageStreamResponse({ stream: replyStream(app.client, runId) });
  } catch (err) {
    const { status, body } = toApiError(err, "a chat turn");
    return Response.json(body, { status });
  }
}

/**
 * Refuses a new chat on an engine it cannot run here, as the composer offers none such
 * (`enginesHere`): our loop, else a plan an installed connector gives its agent; on a live
 * instance, not while it declares no box (`NO_BOX`), nor an own plan whose sign-in is a command run
 * once on the person's computer.
 */
async function checkEngine(app: AppContext, name: string) {
  if (name === "loop") return;
  const { agent, plan } = engineOf(name);
  const installed = app.resolved.agents.get(agent);
  const part = installed?.[plan];
  if (!installed || !part)
    throw invalid(`No engine ${name}: no connector of this company gives its agent on that plan`);
  if (app.place !== "live") return;
  if ("signIn" in part && "once" in part.signIn) {
    throw invalid(`${installed.title} signs in on the person's own computer, not on a live instance`);
  }
  if ((await app.resolved.sandboxes()).length === 0) throw new ApiError(409, { error: NO_BOX });
}

/** The person's new message, checked (a 400 for one a chat does not take). The transcript, written by the worker, is not validated again. */
async function personMessage(sent: unknown): Promise<ChatMessage> {
  const checked = await safeValidateUIMessages<ChatMessage>({ messages: [sent] });
  if (!checked.success) throw invalid(`Not a chat message: ${checked.error.message}`);
  // As a chat takes it: the person's text, under an id of letters, digits, _ and -.
  const turn = PersonMessage.safeParse(checked.data[0]);
  if (!turn.success) {
    throw invalid(`A chat takes the person's messages, as text: ${turn.error.issues[0]?.message ?? "not one"}`);
  }
  return turn.data;
}

/**
 * The reply of the turn `runId` as a UI message stream: the chunks the worker writes
 * (`Chats.chunks`), looked for less often while none come (`POLL_MS`), until the turn's stream
 * ends. A run that ended without ending it (it failed at once, on a worker with no agent; or its
 * worker went away) ends the stream with its error. The browser going away stops the reading, not
 * the turn.
 */
function replyStream(client: SanomaClient, runId: string): ReadableStream<UIMessageChunk> {
  let last = 0;
  let wait = POLL_MS;
  // When it last asked after the run: never, so the first quiet look asks.
  let asked = 0;
  const reading = new AbortController();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      while (!reading.signal.aborted) {
        const read = await client.chats.chunks(runId, last);
        last = read.last;
        for (const chunk of read.chunks) controller.enqueue(chunk);
        if (read.ended) return controller.close();
        if (read.chunks.length) {
          wait = POLL_MS;
          return;
        }
        if (Date.now() - asked >= STATUS_MS) {
          asked = Date.now();
          const run = await client.run(runId);
          if (run && isEnded(run.status)) {
            // What it wrote before it ended, then why.
            const after = await client.chats.chunks(runId, last);
            for (const chunk of after.chunks) controller.enqueue(chunk);
            if (!after.ended) {
              controller.enqueue({ type: "error", errorText: run.error ?? `The turn ${run.status} before it replied` });
            }
            return controller.close();
          }
        }
        await new Promise((done) => setTimeout(done, wait));
        wait = Math.min(wait * 2, QUIET_MS);
      }
    },
    cancel() {
      reading.abort();
    },
  });
}

/** What `POST /api/sign-in` takes: the chat, and the code its person pastes back to the vendor's sign-in. */
const SignInCode = z.object({
  chat: z.string().min(1),
  // One line: the vendor's sign-in reads it as one answer.
  code: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[^\r\n]+$/, "one line"),
});

/**
 * `POST /api/sign-in`: the code the person pastes on their sign-in card, sent sealed to their
 * chat's turn under way (`SanomaClient.turnCode`), whose sign-in writes it to the vendor's (never
 * stored or logged). A chat with no turn of theirs under way is a 404.
 */
export async function postSignInCode(request: Request, context: ActorContext): Promise<Response> {
  try {
    const principal = await requireActor(context);
    const { chat, code } = parse(SignInCode, await request.json().catch(() => undefined), "The request");
    await context.app.client.turnCode(chat, code, { by: principal });
    return new Response(null, { status: 204 });
  } catch (err) {
    const { status, body } = toApiError(err, "a sign-in code");
    return Response.json(body, { status });
  }
}

/**
 * The transcript with what a turn left unfinished settled: in any reply, a held lookup's result
 * once its run has ended (still held while it waits); in the last, as a stop or a restart cut it
 * short, a tool call with no result failed as interrupted, and text and reasoning done. A message
 * it leaves as it was is the same object, so the caller writes back only those it changed.
 */
export async function settle(client: SanomaClient, messages: UIMessage[]): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message, i) => {
      if (message.role !== "assistant" || !message.parts.some(unfinished)) return message;
      const last = i === messages.length - 1;
      const parts = await Promise.all(message.parts.map((part) => settlePart(client, part, last)));
      return parts.every((part, j) => part === message.parts[j]) ? message : { ...message, parts };
    }),
  );
}

async function settlePart(
  client: SanomaClient,
  part: UIMessage["parts"][number],
  last: boolean,
): Promise<UIMessage["parts"][number]> {
  if (!unfinished(part)) return part;
  if (isToolUIPart(part) && part.state === "output-available") {
    const runId = heldRunOf(part.output);
    const run = runId === undefined ? undefined : await client.run(runId);
    // Still waiting: held as it was, for a later turn to settle once the run has ended.
    if (run && !isEnded(run.status)) return part;
    if (!run) return { ...part, preliminary: false };
    try {
      return { ...part, preliminary: false, output: { output: await client.result(run.runId) } };
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

/** The person's chat `id` with its transcript; null when they have none of that id. */
export async function chatFor(
  { client }: Pick<AppContext, "client">,
  principal: Principal,
  id: string,
): Promise<{ chat: Chat; messages: ChatMessage[] } | null> {
  const chat = await client.chats.get(id);
  if (chat?.person !== principal.id) return null;
  // As the next turn will take it: what a stop or a restart cut short settled, unless a turn is under way.
  const [stored, turn] = await Promise.all([client.chats.load(id), client.turn(id)]);
  const underWay = turn !== undefined && !isEnded(turn.status);
  return { chat, messages: (underWay ? stored : await settle(client, stored)) as ChatMessage[] };
}

const invalid = (error: string) => new ApiError(400, { error, code: "invalid_input" });
