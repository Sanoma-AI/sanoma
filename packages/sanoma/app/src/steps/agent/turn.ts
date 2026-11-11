import type { ChatTurnContext, ChatTurnInput, ChatTurnOutput } from "sanoma/workflows";
import { type ChatMessage, engineOf } from "../../lib/chat.ts";
import { settle } from "../../server/chat.ts";
import { acpEngine } from "./acp.ts";
import { harnessEngine } from "./harness.ts";
import { run as loop } from "./loop.ts";
import { type Engine, persist } from "./transcript.ts";

// A chat turn, in the worker (`AppSteps.chat`), whatever engine runs it: the chat's transcript, the
// person's new message in it, and the engines by name. The app checked the message, opened the
// chat and wrote the message before it started the turn's run on its id (`server/chat.ts`); the
// run waited for the turn before it.

/** The app's own engines, by the name a chat's row keeps: our loop. */
export const ENGINES: { readonly loop: Engine } = { loop };

/**
 * The engine of the agent and plan a chat's row names (`engineOf`): our loop (`ENGINES`), or a
 * coding agent of an installed connector (`ResolvedConfig.agents`), on a person's own plan over
 * ACP or on the company's key through `HarnessAgent`. An agent no connector gives fails its turn
 * with a reply that says so.
 */
function engineRunning(name: string): Engine {
  const { agent, plan } = engineOf(name);
  if (agent === "loop") return ENGINES.loop;
  return plan === "own" ? acpEngine(agent) : harnessEngine(agent);
}

/**
 * The turn: the transcript, read from the chat's store, with what the turn before left unfinished
 * settled (`settle`), the person's message (`input.message`, by id) moved after it, and the reply
 * of the chat's engine, written as it streams (`persist`). The person's messages stored after this
 * one were sent while it waited, for turns of their own: they go after it, out of its history. A
 * turn the worker's restart cut short (`resumed`) settles its own reply instead, which `settle`
 * sees as the last, and runs nothing again: the person sends "continue".
 */
export async function chat(step: ChatTurnContext, input: ChatTurnInput): Promise<ChatTurnOutput> {
  const { chats } = step.client;
  const found = await chats.get(input.chat);
  if (!found) throw new Error(`No chat ${input.chat}`);
  const stored = (await chats.load(found.id)) as ChatMessage[];
  const at = stored.findIndex((m) => m.id === input.message);
  const message = stored[at];
  if (message?.role !== "user") throw new Error(`Chat ${input.chat} has no message ${input.message} of its person's`);
  // The rest is its history: a reply of the turn before may have been written after it.
  const next = stored.slice(at + 1).filter((m) => m.role === "user");
  const before = stored.filter((m) => m !== message && !next.includes(m));
  const history = (await settle(step.client, before, found.id)) as ChatMessage[];
  // The messages settle changed.
  await chats.upsert(
    found.id,
    history.filter((m, i) => m !== before[i]),
  );
  if (step.resumed) {
    await chats.end(found.id, step.runId);
    return { interrupted: true };
  }
  await chats.upsert(found.id, [message, ...next], { last: true });
  const reply = await persist(
    step,
    found,
    engineRunning(found.engine)({ chat: found, messages: [...history, message], step }),
  );
  return reply === undefined ? {} : { reply };
}
