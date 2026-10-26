import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessV1 } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { errorMessage } from "@sanoma-ai/workflows/shared";
import {
  createUIMessageStream,
  generateId,
  type InferUIMessageChunk,
  LoadAPIKeyError,
  type UIMessageStreamWriter,
} from "ai";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, ENGINE_NAMES, noKeyText, pathOf, textOf } from "../../lib/chat.ts";
import { checks } from "../drafts.ts";
import { modelRegistry } from "../models.ts";
import { secretValues } from "../secrets.ts";
import { allowedPath, drafting, openDraft } from "./checkout.ts";
import { freePort, LocalSession } from "./local-session.ts";
import { harnessInstructions } from "./prompt.ts";
import { chatResponse, type Engine, type EngineTurn } from "./transcript.ts";

// The chat's second engine: an existing coding agent driven by the AI SDK's `HarnessAgent` in a
// local session of ours (`LocalSession`), in the chat's draft, on the company's model key. Pi runs
// in this process; Claude Code through its adapter's bridge, a child of the session.
// A turn is one harness session: made, run to its end (its permission requests answered by the
// checkout rule), destroyed. Then what the agent changed is committed on the draft and checked.

/** The connector whose model (`<vendor>/default`) and key the coding agents use, with its key's variable and its base URL's. */
const VENDOR = "anthropic";
const KEY = "ANTHROPIC_API_KEY";
const BASE_URL = "ANTHROPIC_BASE_URL";

/** A coding agent `HarnessAgent` drives, on the company's Anthropic key. */
interface Runtime {
  /** Pi takes `<provider>/<model-id>`; a bridge, the bare id. */
  qualified: boolean;
  /** A bridge, a child of the session: its first start installs it under the home the sessions share. */
  bridge: boolean;
  /** Its adapter, loaded when first used, on the key as an explicit `auth` record (never this process's environment or keychain). */
  harness(auth: Record<string, string>, home: string): Promise<HarnessV1>;
}

const RUNTIMES = {
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
} satisfies Record<string, Runtime>;

/** The runtimes' names, each an engine a chat's row keeps. */
export type RuntimeName = keyof typeof RUNTIMES;

/** What the agent is told when a shell command or a path outside the checkout rule is refused. */
const NO_SHELL = "No shell commands in this chat until previews exist: edit the files; the checks run after your turn";

/** A bridge's first session, by its runtime: it installs the bridge under the shared home, so the next ones wait for it. */
const installing = new Map<RuntimeName, Promise<unknown>>();

/** The engine for `name`: a turn of a chat through that runtime, its transcript written as it goes. */
export const harnessEngine =
  (name: RuntimeName): Engine =>
  async (turn) => {
    const { app, chat } = turn;
    const stream = createUIMessageStream<ChatMessage>({
      onError: (err) => {
        // A missing key (`authFor`'s words); the adapter's or the bridge's own otherwise (a bootstrap
        // that failed, say).
        if (LoadAPIKeyError.isInstance(err)) return err.message;
        console.error(`sanoma app: a ${ENGINE_NAMES[name]} turn failed:`, err);
        return errorMessage(err);
      },
      execute: ({ writer }) => runTurn(name, turn, writer),
    });
    return chatResponse(app, chat, stream);
  };

async function runTurn(
  name: RuntimeName,
  { app, chat, messages, principal, signal }: EngineTurn,
  writer: UIMessageStreamWriter<ChatMessage>,
) {
  const runtime: Runtime = RUNTIMES[name];
  const repo = drafting(app);
  // Kept across restarts: a bridge installs its agent under it once.
  const home = join(repo.root, ".sanoma", "agent-home");
  // The key first: a turn without it opens no draft.
  const auth = await authFor(app);
  // The agent works in the chat's draft from its first turn.
  const [draft, model, port] = await Promise.all([
    openDraft(app, chat),
    modelFor(app, runtime),
    freePort(),
    mkdir(home, { recursive: true }),
  ]);
  const sessionId = `${chat.id}-${generateId()}`;
  const local = new LocalSession({ id: sessionId, root: draft.root, home, port });
  const harness = await runtime.harness(auth, home);
  const agent = new HarnessAgent({
    harness,
    model,
    instructions: harnessInstructions(app, principal, chat, messages.slice(0, -1)),
    // Edits and commands ask first, and the checkout rule answers.
    permissionMode: "allow-reads",
    // The draft's checkout itself, not a directory per session under it.
    sandboxConfig: { workDir: "." },
  });
  const said = messages.at(-1)!;
  let failed: { err: unknown } | undefined;
  try {
    const create = () => agent.createSession({ sessionId, sandboxSession: local, abortSignal: signal });
    const installed = installing.get(name);
    const started = installed ? installed.then(create) : create();
    // Kept as whether it started (not the session); a failed first start is tried again by the next.
    if (runtime.bridge && !installed) {
      installing.set(
        name,
        started.then(
          () => undefined,
          () => void installing.delete(name),
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
            answer(draft.root, approvalId, toolCall.toolName, kinds[toolCall.toolName]?.toolUseKind, toolCall.input),
          ),
        );
        result = await agent.continueStream({ session, toolApprovalContinuations: answers, abortSignal: signal });
      }
    } finally {
      await session.destroy();
    }
  } catch (err) {
    failed = { err };
  } finally {
    await local.destroy();
  }
  // What it changed is kept on the draft, and shown, however the turn ended (an error too); a turn a
  // new message stopped leaves the card to the next.
  const message = `${ENGINE_NAMES[name]}: ${textOf(said, " ").trim().slice(0, 72)}`;
  const committed = (await draft.commit({ paths: ["."], message, author: principal.id })) !== undefined;
  if (committed && !signal.aborted) {
    const [checked, diff] = await Promise.all([checks(draft.root, app.resolved.databaseUrl), repo.diff(chat.id)]);
    writer.write({ type: "data-draft", id: "draft", data: { branch: draft.branch, ...diff, checks: checked } });
  }
  if (failed) throw failed.err;
  writer.write({ type: "finish" });
}

/**
 * The company's key, as the adapter's `auth`: its variable, and its base URL's when this process
 * sets one (a stand-in's, in tests). Without it, `LoadAPIKeyError` says so, with the connector's
 * page when the company has the connector (`noKeyText`).
 */
async function authFor(app: AppContext): Promise<Record<string, string>> {
  const value = (await secretValues(app.client)([KEY])).get(KEY);
  if (!value) {
    const message = `${VENDOR} is not configured: ${KEY}`;
    throw new LoadAPIKeyError({
      message: app.description.vendors[VENDOR]
        ? noKeyText(VENDOR, `${message}; set it on the connector page`)
        : `${message}; no connector gives it yet`,
    });
  }
  const base = process.env[BASE_URL];
  return { [KEY]: value, ...(base && { [BASE_URL]: base }) };
}

/** The model `<vendor>/default` names, as the runtime takes it; the runtime's own default without that connector. */
async function modelFor(app: AppContext, { qualified }: Runtime): Promise<string | undefined> {
  if (!app.resolved.models.has(VENDOR)) return undefined;
  const { modelId } = (await modelRegistry(app)).languageModel(`${VENDOR}/default`);
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
    return deny(`${path} is outside your checkout, or under .git or node_modules`);
  }
  return { type: "tool-approval-response" as const, approvalId, approved: true };
}
