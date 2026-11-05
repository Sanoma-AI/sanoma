import { join } from "node:path";
import type { HarnessV1, HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { AppStepContext } from "@sanoma-ai/workflows";
import { errorMessage } from "@sanoma-ai/workflows/shared";
import {
  createUIMessageStream,
  generateId,
  type InferUIMessageChunk,
  LoadAPIKeyError,
  type UIMessageStreamWriter,
} from "ai";
import { type ChatMessage, ENGINE_NAMES, noKeyText, pathOf, textOf } from "../../lib/chat.ts";
import { modelRegistry } from "../../server/models.ts";
import { secretValues } from "../../server/secrets.ts";
import { boxSession, homeOf } from "./box-session.ts";
import { boxTurn, carryIn, carryOut } from "./carrier.ts";
import {
  agentHome,
  allowedPath,
  boxName,
  commitTurn,
  NO_SHELL,
  openDraft,
  outsideCheckout,
  turnMessage,
} from "./checkout.ts";
import { freePort, localBackend } from "./local-box.ts";
import { harnessInstructions } from "./prompt.ts";
import type { Engine, EngineTurn } from "./transcript.ts";

// The chat's second engine: an existing coding agent driven by the AI SDK's `HarnessAgent` in a
// session of ours over the person's box (`boxSession`), in the box's clone of the chat's draft, on
// the company's model key. Pi runs in this process; Claude Code through its adapter's bridge, in
// the box. A turn opens the box (one turn in it at a time), carries the draft into it (`carryIn`)
// and is one harness session: made, run to its end (its permission requests answered by the
// checkout rule), destroyed. Then what the agent changed is committed in the box, carried back to
// the draft (`carryOut`) and checked there, and the box is stopped.

/** The connector whose model (`<vendor>/default`) and key the coding agents use, with its key's variable and its base URL's. */
const VENDOR = "anthropic";
const KEY = "ANTHROPIC_API_KEY";
const BASE_URL = "ANTHROPIC_BASE_URL";

/** A coding agent `HarnessAgent` drives, on the company's Anthropic key. */
interface Runtime {
  /** Pi takes `<provider>/<model-id>`; a bridge, the bare id. */
  qualified: boolean;
  /** A bridge, a child of the session: its first start in a box installs it under the box's home. */
  bridge: boolean;
  /** Its adapter, loaded when first used, on the key as an explicit `auth` record (never this process's environment or keychain). */
  harness(auth: Record<string, string>, home: string): Promise<HarnessV1>;
}

/** The runtimes' names, each an engine a chat's row keeps. */
export type RuntimeName = "pi" | "claude-code";

const RUNTIMES: Readonly<Record<RuntimeName, Runtime>> = {
  pi: {
    qualified: true,
    bridge: false,
    // Pi's own settings under the session's home, not this user's ~/.pi.
    harness: async (auth, home) =>
      (await import("@ai-sdk/harness-pi")).createPi({ auth, agentDir: join(home, ".pi", "agent") }),
  },
  "claude-code": {
    qualified: false,
    bridge: true,
    harness: async (auth) =>
      (await import("@ai-sdk/harness-claude-code")).createClaudeCode({
        auth,
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
      }),
  },
  // Later: Codex, once its adapter asks before an edit or a command (vercel/ai#22550); it runs only
  // `allow-all`, which the checkout rule could not answer for. Then a vendor per runtime.
};

/** A bridge's first session in a box, by its runtime and the box's id: it installs the bridge there, so the next ones wait for it. */
const installing = new Map<string, Promise<unknown>>();

/** The engine for `name`: a turn of a chat through that runtime. */
export const harnessEngine =
  (name: RuntimeName): Engine =>
  (turn) =>
    createUIMessageStream<ChatMessage>({
      onError: (err) => {
        // A missing key (`authFor`'s words); the adapter's or the bridge's own otherwise (a bootstrap
        // that failed, say).
        if (LoadAPIKeyError.isInstance(err)) return err.message;
        console.error(`sanoma app: a ${ENGINE_NAMES[name]} turn failed:`, err);
        return errorMessage(err);
      },
      execute: ({ writer }) => runTurn(name, turn, writer),
    });

async function runTurn(name: RuntimeName, turn: EngineTurn, writer: UIMessageStreamWriter<ChatMessage>) {
  const { step, chat } = turn;
  // The key first: a turn without it opens no draft.
  const auth = await authFor(step);
  // The agent works in the chat's draft from its first turn, in the person's box, opened last
  // so that nothing that fails before leaves it running.
  const [draft, model, port] = await Promise.all([openDraft(step, chat), modelFor(step, RUNTIMES[name]), freePort()]);
  const title = ENGINE_NAMES[name];
  // S5: the declared sandbox's backend (`resolved.sandboxes()`, its connector's `sandbox`), when there is one.
  const backend = localBackend(agentHome(step, "boxes"));
  // This machine is the local box's image and size.
  const opened = { name: boxName(step.resolved.appName, step.by.id), image: "", size: 0 };
  await boxTurn(backend, opened, async (box) => {
    // Kept across turns: a bridge installs its agent under it once, and the clone stays.
    const home = await homeOf(box);
    const { root, head } = await carryIn(box, step.source, chat.id, home);
    try {
      const sandbox = boxSession(box, { id: `${chat.id}-${generateId()}`, root, home, ports: [port] });
      try {
        await converse(name, turn, writer, sandbox, { auth, model, home, box: box.id });
      } finally {
        await sandbox.destroy();
      }
    } finally {
      // However the turn ended (an error too): its error, if any, follows the commit.
      try {
        await carryOut(box, step.source, chat.id, {
          since: head,
          message: turnMessage(turn, title),
          author: step.by.id,
        });
      } finally {
        await commitTurn(turn, draft, title, writer, head);
      }
    }
  });
  writer.write({ type: "finish" });
}

/** The turn's harness session in `sandbox`, run to its end, its permission requests answered by the checkout rule. */
async function converse(
  name: RuntimeName,
  { step, chat, messages }: EngineTurn,
  writer: UIMessageStreamWriter<ChatMessage>,
  sandbox: HarnessV1NetworkSandboxSession,
  { auth, model, home, box }: { auth: Record<string, string>; model: string | undefined; home: string; box: string },
) {
  const { by: principal, signal } = step;
  const runtime: Runtime = RUNTIMES[name];
  const harness = await runtime.harness(auth, home);
  const agent = new HarnessAgent({
    harness,
    model,
    instructions: harnessInstructions(step, principal, chat, messages.slice(0, -1)),
    // Edits and commands ask first, and the checkout rule answers.
    permissionMode: "allow-reads",
    // The draft's checkout itself, not a directory per session under it.
    sandboxConfig: { workDir: "." },
  });
  const said = messages.at(-1)!;
  const create = () => agent.createSession({ sessionId: sandbox.id, sandboxSession: sandbox, abortSignal: signal });
  const key = `${name} ${box}`;
  const installed = installing.get(key);
  const started = installed ? installed.then(create) : create();
  // Kept as whether it started (not the session); a failed first start is tried again by the next.
  if (runtime.bridge && !installed) {
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
    let result = await agent.stream({ session, prompt: textOf(said), abortSignal: signal });
    for (let first = true; ; first = false) {
      for await (const chunk of result.toUIMessageStream({
        sendStart: first,
        sendFinish: false,
        generateMessageId: generateId,
      })) {
        // As the chat's chunk: a company's install has the harness's own copy of the AI SDK (its
        // exact pin), whose chunk types are not this one's, though the chunks are.
        writer.write(chunk as InferUIMessageChunk<ChatMessage>);
      }
      const asked = (await result.content).filter((part) => part.type === "tool-approval-request");
      if (!asked.length || signal.aborted) break;
      const kinds = harness.builtinTools as Record<string, { toolUseKind?: string } | undefined>;
      const answers = await Promise.all(
        asked.map(({ approvalId, toolCall }) =>
          answer(
            sandbox.defaultWorkingDirectory,
            approvalId,
            toolCall.toolName,
            kinds[toolCall.toolName]?.toolUseKind,
            toolCall.input,
          ),
        ),
      );
      result = await agent.continueStream({ session, toolApprovalContinuations: answers, abortSignal: signal });
    }
  } finally {
    await session.destroy();
  }
}

/**
 * The company's key, as the adapter's `auth`: its variable, and its base URL's when this process
 * sets one (a stand-in's, in tests). Without it, `LoadAPIKeyError` says so, with the connector's
 * page when the company has the connector (`noKeyText`).
 */
async function authFor({ client, resolved }: AppStepContext): Promise<Record<string, string>> {
  const value = (await secretValues(client)([KEY])).get(KEY);
  if (!value) {
    const message = `${VENDOR} is not configured: ${KEY}`;
    throw new LoadAPIKeyError({
      message: resolved.models.has(VENDOR)
        ? noKeyText(VENDOR, `${message}; set it on the connector page`)
        : `${message}; no connector gives it yet`,
    });
  }
  const base = process.env[BASE_URL];
  return { [KEY]: value, ...(base && { [BASE_URL]: base }) };
}

/** The model `<vendor>/default` names, as the runtime takes it; the runtime's own default without that connector. */
async function modelFor(step: AppStepContext, { qualified }: Runtime): Promise<string | undefined> {
  if (!step.resolved.models.has(VENDOR)) return undefined;
  const { modelId } = (await modelRegistry(step)).languageModel(`${VENDOR}/default`);
  return qualified ? `${VENDOR}/${modelId}` : modelId;
}

/**
 * The checkout rule's answer to a built-in call: an edit of a file the rule allows in the draft
 * (`allowedPath`) is approved; a command, an edit outside it or under `.git` or `node_modules`, and
 * any other call that asks, are denied with the reason, which the agent reads. Never a policy call.
 */
async function answer(root: string, approvalId: string, toolName: string, kind: string | undefined, input: unknown) {
  const deny = (reason: string) => ({ type: "tool-approval-response" as const, approvalId, approved: false, reason });
  if (kind === "bash") return deny(`${toolName}: ${NO_SHELL}`);
  const path = pathOf(input);
  if (kind !== "edit" || path === undefined) {
    return deny(`${toolName} is not available in this chat: edit the files in your checkout`);
  }
  if ((await allowedPath(root, path)) === undefined) {
    return deny(outsideCheckout(path));
  }
  return { type: "tool-approval-response" as const, approvalId, approved: true };
}
