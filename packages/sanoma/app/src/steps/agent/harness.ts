import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { type AppStepContext, type Box, type CheckResult, statusesOf, unconfigured } from "sanoma/workflows";
import { errorMessage } from "sanoma/workflows/shared";
import {
  createUIMessageStream,
  generateId,
  type InferUIMessageChunk,
  LoadAPIKeyError,
  type UIMessageStreamWriter,
} from "ai";
import { type ChatMessage, noKeyText, textOf } from "../../lib/chat.ts";
import { modelRegistry } from "../../server/models.ts";
import { secretValues } from "../../server/secrets.ts";
import { boxSession, homeOf, personBox } from "./box-session.ts";
import { boxTurn, carryIn, carryOut, checkIn } from "./carrier.ts";
import { agentOn, openDraft, showCommits, type TurnAgent, turnMessage } from "./checkout.ts";
import { freePort } from "./local-box.ts";
import { harnessInstructions } from "./prompt.ts";
import type { Engine, EngineTurn } from "./transcript.ts";

// The chat's second engine: an existing coding agent driven by the AI SDK's `HarnessAgent` in a
// session of ours over the person's box (`boxSession`), in the box's clone of the chat's draft, on
// the company's model key. Pi runs in this process; Claude Code through its adapter's bridge, in
// the box. A turn opens the box (one turn in it at a time), carries the draft into it (`carryIn`)
// and is one harness session: made, run to its end (every built-in tool allowed, `allow-all`: the
// box is the boundary), destroyed (what it started killed). Then what the agent changed is committed in
// the box and carried back to the draft (`carryOut`), the draft checked in the box (`checkIn`),
// and the box is stopped.

/** A bridge's first session in a box, by its runtime and the box's id: it installs the bridge there, so the next ones wait for it. */
const installing = new Map<string, Promise<unknown>>();

/** The engine for the agent `id`: a turn of a chat through that agent on the company's key. */
export const harnessEngine =
  (id: string): Engine =>
  (turn) =>
    createUIMessageStream<ChatMessage>({
      onError: (err) => {
        // A missing key (`authFor`'s words); the adapter's or the bridge's own otherwise (a bootstrap
        // that failed, say).
        if (LoadAPIKeyError.isInstance(err)) return err.message;
        console.error(`sanoma app: a ${id} turn failed:`, err);
        return errorMessage(err);
      },
      execute: ({ writer }) => runTurn(agentOn(turn.step.resolved, id, "onKey"), turn, writer),
    });

async function runTurn(agent: TurnAgent<"onKey">, turn: EngineTurn, writer: UIMessageStreamWriter<ChatMessage>) {
  const { step, chat } = turn;
  // The box chosen and the key first: a turn without either opens no draft.
  const person = await personBox(step);
  const auth = await authFor(step, agent);
  // The agent works in the chat's draft from its first turn, in the person's box, opened last
  // so that nothing that fails before leaves it running.
  const [draft, model, port] = await Promise.all([openDraft(step, chat), modelFor(step, agent), freePort()]);
  /** Whether the box's commits reached the draft, and their check in the box. */
  let carried = false;
  let checked: CheckResult | undefined;
  try {
    await boxTurn(person.name, person.open, async (box) => {
      // Kept across turns: a bridge installs its agent under it once, and the clone stays.
      const home = await homeOf(box);
      const cloned = await carryIn(box, step.source, chat.id, { home, signal: step.signal }).catch((err: unknown) => {
        // A stopped turn says nothing.
        if (step.signal.aborted) return undefined;
        throw err;
      });
      if (!cloned) return;
      const { root, head } = cloned;
      const sandbox = boxSession(box, { id: `${chat.id}-${generateId()}`, root, home, ports: [port] });
      // However the turn ended (an error too): the session destroyed, so nothing in the box writes
      // again, then what it changed committed in the box and carried back to the draft. A failed
      // carry is the turn's error (its edits are lost), the one before it logged.
      const ended = await converse(agent, turn, writer, sandbox, { auth, model, home, box })
        .finally(() => sandbox.destroy())
        .then(
          () => undefined,
          (err: unknown) => ({ err }),
        );
      try {
        const message = turnMessage(turn, agent.title);
        carried = await carryOut(box, step.source, chat.id, { since: head, message, author: step.by.id });
      } catch (err) {
        if (ended) console.error(`sanoma app: the turn in the box ${box.id} failed:`, ended.err);
        throw err;
      }
      // Unless a new message stopped the turn: its own turn checks.
      if (carried && !step.signal.aborted) checked = await checkIn(box, { signal: step.signal });
      if (ended) throw ended.err;
    });
  } finally {
    // Shown once the box is free: the turn's error, if any, follows the card.
    if (carried) await showCommits(turn, draft, writer, checked);
  }
  writer.write({ type: "finish" });
}

/** The turn's harness session in `sandbox`, run to its end. */
async function converse(
  agent: TurnAgent<"onKey">,
  { step, chat, messages }: EngineTurn,
  writer: UIMessageStreamWriter<ChatMessage>,
  sandbox: HarnessV1NetworkSandboxSession,
  { auth, model, home, box }: { auth: Record<string, string>; model: string | undefined; home: string; box: Box },
) {
  const { by: principal, signal } = step;
  const harness = await agent.harness(auth, home);
  const harnessAgent = new HarnessAgent({
    harness,
    model,
    instructions: harnessInstructions(step, principal, chat, messages.slice(0, -1)),
    // Its built-in tools, its shell among them, run without asking: they run in the box, which is
    // the boundary, so nothing asks for an approval.
    permissionMode: "allow-all",
    // The draft's checkout itself, not a directory per session under it.
    sandboxConfig: { workDir: "." },
  });
  const said = messages.at(-1)!;
  const create = () =>
    harnessAgent.createSession({ sessionId: sandbox.id, sandboxSession: sandbox, abortSignal: signal });
  const key = `${agent.id} ${box.id}`;
  const installed = installing.get(key);
  const started = installed ? installed.then(create) : create();
  // Kept as whether it started (not the session); a failed first start is tried again by the next.
  if (agent.bridge && !installed) {
    installing.set(
      key,
      started.then(
        () => undefined,
        () => void installing.delete(key),
      ),
    );
  }
  const session = await started;
  try {
    const result = await harnessAgent.stream({ session, prompt: textOf(said), abortSignal: signal });
    for await (const chunk of result.toUIMessageStream({ sendFinish: false, generateMessageId: generateId })) {
      // As the chat's chunk: a company's install has the harness's own copy of the AI SDK (its
      // exact pin), whose chunk types are not this one's, though the chunks are.
      writer.write(chunk as InferUIMessageChunk<ChatMessage>);
    }
  } finally {
    await session.destroy();
  }
}

/**
 * The company's key, as the adapter's `auth`: the variables the model connector's driver declares
 * (`KeyAgent.model`), and the endpoint's (`baseUrl`) when this process sets one (a stand-in's, in
 * tests). Without the connector or a key, `LoadAPIKeyError` says so, with the connector's page
 * when the company has the connector (`noKeyText`).
 */
async function authFor(
  { client, resolved }: AppStepContext,
  agent: TurnAgent<"onKey">,
): Promise<Record<string, string>> {
  const { model: vendor, baseUrl, title } = agent;
  if (!resolved.models.has(vendor)) {
    throw new LoadAPIKeyError({
      message: `${title} runs on ${vendor}'s model, and no connector of this company gives it: add ${vendor}'s connector to sanoma.config.ts`,
    });
  }
  const env = resolved.driversByVendor.get(vendor)?.env;
  // A model connector declares its key in its driver's `env`, as the connector page reads it.
  const names = Object.keys(env?.shape ?? {});
  if (!env || !names.length) {
    throw new LoadAPIKeyError({ message: `${title} runs on ${vendor}'s key, and its connector declares none` });
  }
  const values = await secretValues(client)(names);
  const why = unconfigured(
    vendor,
    statusesOf(env, (name) => values.get(name)),
  );
  if (why) throw new LoadAPIKeyError({ message: noKeyText(vendor, why) });
  const auth = Object.fromEntries([...values].filter((entry): entry is [string, string] => !!entry[1]));
  const base = baseUrl && process.env[baseUrl];
  return base ? { ...auth, [baseUrl]: base } : auth;
}

/** The model `<vendor>/default` names, as the agent takes it. */
async function modelFor(step: AppStepContext, { model: vendor, qualified }: TurnAgent<"onKey">): Promise<string> {
  const { modelId } = (await modelRegistry(step)).languageModel(`${vendor}/default`);
  return qualified ? `${vendor}/${modelId}` : modelId;
}
