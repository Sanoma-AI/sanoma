import { type Chat, ChatTurnInput, type Principal, type RunSummary, type SanomaClient } from "sanoma/workflows";
import { CHAT_AGENT, isEnded } from "sanoma/workflows/shared";
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
  catalogCallId,
  type ChatMessage,
  enginesHere,
  heldPart,
  heldRunOf,
  type LookupOutput,
  noModelText,
  onModelConnector,
  type RunOutput,
  textOf,
  turnOf,
  unfinished,
  written,
} from "../lib/chat.ts";
import { callRunId, catalogName, lookupOutput, runOutput } from "./catalog.ts";
import { type ActorContext, appConfig, parse, requireActor, toApiError } from "./core.ts";
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
    // A chat keeps its engine, whose turn says what it lacks; a new one opens only on one the composer offers here.
    if (!chat) {
      const here = enginesHere(appConfig(app)).map((engine) => engine.name);
      if (!here.includes(body.engine))
        throw invalid(`No engine ${body.engine} here: the engines are ${here.join(", ")}`);
    }
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
 * The transcript of the chat `chat` with what a turn left unfinished settled. In any reply, a held
 * call or start (its card shown while its turn waited, or answered past the wait that it still
 * waits, `StillHeld`) is its run's present state once that is no longer waiting: the tool's own
 * output for it (`runOutput`, `lookupOutput`), so the next turn's model has the run's id and what
 * became of it; while the run waits the part stays as it was. In the last reply, as a stop or a
 * restart cut it short, text and reasoning are done, and a tool call with no result failed as
 * interrupted, unless it is one of the agent catalog's that leaves a run (`callRunId`: `start_run`,
 * `drift`, a held `lookup`) and its run is there, found by the call's idempotency id
 * (`catalogCallId`): then the part answers from it, so the model is not led to start it again. The
 * id is of the message whose turn wrote the reply, which the reply records (`turnOf`, written by
 * `persist`); a reply stored before it was recorded falls back to `turn` (a resumed turn gives its
 * own message, since its history holds the message apart; without it, the person's last message
 * in `messages`). A message it leaves as it was is the same object, so the caller writes back only
 * those it changed.
 */
export async function settle(
  client: SanomaClient,
  messages: UIMessage[],
  chat: string,
  turn: string | undefined = messages.findLast((m) => m.role === "user")?.id,
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message, i) => {
      if (message.role !== "assistant" || !message.parts.some((part) => unfinished(part) || heldPart(part))) {
        return message;
      }
      const wrote = turnOf(message) ?? turn;
      const callId = (toolCallId: string) => (wrote === undefined ? undefined : catalogCallId(chat, wrote, toolCallId));
      const last = i === messages.length - 1;
      const parts = await Promise.all(message.parts.map((part) => settlePart(client, part, last, callId)));
      return parts.every((part, j) => part === message.parts[j]) ? message : { ...message, parts };
    }),
  );
}

type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

async function settlePart(
  client: SanomaClient,
  part: Part,
  last: boolean,
  callId: (toolCallId: string) => string | undefined,
): Promise<Part> {
  if (isToolUIPart(part) && part.state === "output-available") {
    const runId = heldRunOf(part.output);
    const run = runId === undefined ? undefined : await client.run(runId);
    if (run) return fromRun(client, part, run);
    // No run to answer from: a preliminary output is as far as it got.
    return part.preliminary === true ? { ...part, preliminary: false } : part;
  }
  if (!unfinished(part)) return part;
  // Only the last reply can have been cut short; an earlier one's own turn settled it.
  if (!last) return part;
  if (!isToolUIPart(part)) return { ...part, state: "done" } as typeof part;
  if (part.state !== "input-streaming" && part.state !== "input-available") return part;
  const name = getToolName(part);
  const id = callId(part.toolCallId);
  const runId = id === undefined ? undefined : callRunId(name, id, CHAT_AGENT);
  const run = runId === undefined ? undefined : await client.run(runId);
  // A call cut short while its input streamed has none.
  const called = { ...part, input: part.input ?? {} };
  if (run) return fromRun(client, called, run);
  return {
    ...called,
    state: "output-error",
    errorText: `${name} was interrupted: the server restarted before it finished`,
  };
}

/** The tool part `part` answered with `output`, the tool's own (`RunOutput`, `LookupOutput`): final, or `preliminary` while its run is held. */
const answered = (part: ToolPart, output: RunOutput | LookupOutput, preliminary = false): Part =>
  ({ ...part, state: "output-available", output, preliminary }) as Part;

/**
 * A catalog tool's part answered from its run `run`, just read: the run a held part names, or the
 * one a call a restart cut short left. A lookup's held call: held until it ended, then its result
 * (`lookupOutput`), or its failure as the tool's error, as the tool itself throws it. A start's
 * run (`start_run`, `drift`): held while it waits for an approval, then where it stands
 * (`runOutput`), a failed one too. A part held already stays the same object while its run waits.
 */
async function fromRun(client: SanomaClient, part: ToolPart, run: RunSummary): Promise<Part> {
  const { runId } = run;
  const lookup = catalogName(getToolName(part)) === "lookup";
  if (lookup ? !isEnded(run.status) : run.status === "waiting") {
    const held = part.state === "output-available" && heldRunOf(part.output) === runId;
    return held ? part : answered(part, { held: { runId } }, true);
  }
  if (!lookup) return answered(part, await runOutput(client, run));
  try {
    return answered(part, lookupOutput(await client.result(runId)));
  } catch (err) {
    const { preliminary: _, output: __, ...rest } = part as ToolPart & { preliminary?: boolean; output?: unknown };
    return { ...rest, state: "output-error", errorText: String((err as Error).message ?? err) } as Part;
  }
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
  return { chat, messages: (underWay ? stored : await settle(client, stored, chat.id)) as ChatMessage[] };
}

const invalid = (error: string) => new ApiError(400, { error, code: "invalid_input" });
