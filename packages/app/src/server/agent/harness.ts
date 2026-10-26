import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessV1, HarnessV1PermissionMode } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createPi } from "@ai-sdk/harness-pi";
import type { Draft, Principal } from "@sanoma-ai/workflows";
import {
  createUIMessageStream,
  generateId,
  type InferUIMessageChunk,
  LoadAPIKeyError,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import type { AppContext } from "../../context.ts";
import { type ChatMessage, ENGINE_NAMES, noKeyText, textOf } from "../../lib/chat.ts";
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

/** A coding agent `HarnessAgent` drives: whose key it spends and how its adapter is made. */
interface Runtime {
  /** The connector whose model and key it uses (`<vendor>/default`'s model id, and its key's variable). */
  vendor: string;
  /** The key's variable, read through the app's secrets (the environment's, then the connector page's). */
  key: string;
  /** Its base URL's variable, passed on when this process's environment sets one (a stand-in's, in tests). */
  baseUrl: string;
  /** Pi takes `<provider>/<model-id>`; a bridge, the bare id. */
  qualified: boolean;
  /** Which built-in calls ask first: `allow-reads` asks for edits and commands, which the checkout rule answers. */
  permissionMode: HarnessV1PermissionMode;
  /** Its adapter, on the key as an explicit `auth` record (never this process's environment or keychain). */
  harness(auth: Record<string, string>, home: string): HarnessV1;
}

const RUNTIMES = {
  pi: {
    vendor: "anthropic",
    key: "ANTHROPIC_API_KEY",
    baseUrl: "ANTHROPIC_BASE_URL",
    qualified: true,
    permissionMode: "allow-reads",
    // Pi's own settings under the session's home, not this user's ~/.pi.
    harness: (auth, home) => createPi({ auth, agentDir: join(home, ".pi", "agent") }),
  },
  "claude-code": {
    vendor: "anthropic",
    key: "ANTHROPIC_API_KEY",
    baseUrl: "ANTHROPIC_BASE_URL",
    qualified: false,
    permissionMode: "allow-reads",
    harness: (auth) =>
      createClaudeCode({ auth, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } }),
  },
  // Later: Codex, once its adapter asks before an edit or a command (vercel/ai#22550); it runs only
  // `allow-all`, which the checkout rule could not answer for.
} satisfies Record<string, Runtime>;

/** The runtimes' names, each an engine a chat's row keeps. */
export type RuntimeName = keyof typeof RUNTIMES;

/** What the agent is told when a shell command or a path outside the checkout rule is refused. */
const NO_SHELL = "No shell commands in this chat until previews exist: edit the files; the checks run after your turn";

const git = promisify(execFile);

/** The session starting, if any: sessions start one at a time. */
let starting: Promise<unknown> = Promise.resolve();

/** The engine for `name`: a turn of a chat through that runtime, its transcript written as it goes. */
export const harnessEngine =
  (name: RuntimeName): Engine =>
  async (turn) => {
    const runtime: Runtime = RUNTIMES[name];
    const { app, chat } = turn;
    const vendor = runtime.vendor;
    const stream = createUIMessageStream<ChatMessage>({
      onError: (err) => {
        // A missing key, with the page that sets it when a connector has one; the adapter's or the
        // bridge's own words otherwise (a bootstrap that failed, say).
        if (LoadAPIKeyError.isInstance(err)) {
          return app.description.vendors[vendor] ? noKeyText(vendor, err.message) : err.message;
        }
        console.error(`sanoma app: a ${ENGINE_NAMES[name]} turn failed:`, err);
        return err instanceof Error ? err.message : String(err);
      },
      execute: ({ writer }) => runTurn(name, runtime, turn, writer),
    });
    return chatResponse(app, chat, stream);
  };

async function runTurn(
  name: RuntimeName,
  runtime: Runtime,
  { app, chat, messages, principal, signal }: EngineTurn,
  writer: UIMessageStreamWriter<ChatMessage>,
) {
  const repo = drafting(app);
  // The agent works in the chat's draft from its first turn.
  const draft = await openDraft(app, chat);
  const [auth, model, instructions] = await Promise.all([
    authFor(app, runtime),
    modelFor(app, runtime),
    harnessInstructions(app, principal, chat, messages.slice(0, -1)),
  ]);
  // Kept across restarts: a bridge installs its agent under it once.
  const home = join(repo.root, ".sanoma", "agent-home");
  await mkdir(home, { recursive: true });
  const sessionId = `${chat.id}-${generateId()}`;
  const local = new LocalSession({ id: sessionId, root: draft.root, home, port: await freePort() });
  const agent = new HarnessAgent({
    harness: runtime.harness(auth, home),
    model,
    instructions,
    permissionMode: runtime.permissionMode,
    // The draft's checkout itself, not a directory per session under it.
    sandboxConfig: { workDir: "." },
  });
  const said = messages.at(-1)!;
  let committed = false;
  try {
    // One at a time: a bridge's first session installs it under the home they share.
    const started = starting.then(() => agent.createSession({ sessionId, sandboxSession: local, abortSignal: signal }));
    starting = started.catch(() => undefined);
    const session = await started;
    try {
      let result = await agent.stream({ session, prompt: textOf(said), abortSignal: signal });
      for (let first = true; ; first = false) {
        const asked = await relay(
          result.toUIMessageStream({ sendStart: first, sendFinish: false, generateMessageId: generateId }),
          writer,
        );
        if (!asked.length || signal.aborted) break;
        const answers = await Promise.all(asked.map((ask) => answer(draft.root, ask)));
        result = await agent.continueStream({ session, toolApprovalContinuations: answers, abortSignal: signal });
      }
    } finally {
      await session.destroy();
    }
  } finally {
    await local.destroy();
    // What it changed is kept on the draft however the turn ended (an error, or a new message).
    committed = await commitTurn(draft, principal, `${ENGINE_NAMES[name]}: ${textOf(said, " ").trim().slice(0, 72)}`);
  }
  if (committed && !signal.aborted) {
    const checked = await checks(draft.root, app.resolved.databaseUrl);
    writer.write({
      type: "data-draft",
      id: "draft",
      data: { branch: draft.branch, ...(await repo.diff(chat.id)), checks: checked },
    });
  }
  writer.write({ type: "finish" });
}

/** The company's key for `runtime`, as the adapter's `auth`: its variable, and its base URL's when this process sets one. */
async function authFor(app: AppContext, { vendor, key, baseUrl }: Runtime): Promise<Record<string, string>> {
  const value = (await secretValues(app.client)([key])).get(key);
  if (!value) {
    const where = app.description.vendors[vendor] ? "set it on the connector page" : `no connector gives it yet`;
    throw new LoadAPIKeyError({ message: `${vendor} is not configured: ${key}; ${where}` });
  }
  const base = process.env[baseUrl];
  return { [key]: value, ...(base && { [baseUrl]: base }) };
}

/** The model `<vendor>/default` names, as the runtime takes it; the runtime's own default without that connector. */
async function modelFor(app: AppContext, { vendor, qualified }: Runtime): Promise<string | undefined> {
  if (!app.resolved.models.has(vendor)) return undefined;
  const { modelId } = (await modelRegistry(app)).languageModel(`${vendor}/default`);
  return qualified ? `${vendor}/${modelId}` : modelId;
}

/** A built-in call the agent asks to make. */
interface Ask {
  approvalId: string;
  toolName: string;
  input: unknown;
}

/** Writes `chunks` to the reply, and gives the calls among them that ask for an answer. */
async function relay(
  chunks: AsyncIterable<UIMessageChunk>,
  writer: UIMessageStreamWriter<ChatMessage>,
): Promise<Ask[]> {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  const asked: Ask[] = [];
  for await (const chunk of chunks) {
    // The agent's built-in tools are not our loop's, which the chat's message type names: as any engine's.
    writer.write(chunk as InferUIMessageChunk<ChatMessage>);
    if (chunk.type === "tool-input-available") calls.set(chunk.toolCallId, chunk);
    if (chunk.type === "tool-approval-request") {
      const call = calls.get(chunk.toolCallId);
      asked.push({ approvalId: chunk.approvalId, toolName: call?.toolName ?? "", input: call?.input });
    }
  }
  return asked;
}

/**
 * The checkout rule's answer to a built-in call: one that names a path the rule allows in the
 * draft (`allowedPath`) is approved; a path outside it, under `.git` or `node_modules`, or a
 * command (no path), is denied with the reason, which the agent reads. Never a policy call.
 */
async function answer(root: string, { approvalId, toolName, input }: Ask) {
  const fields = (input ?? {}) as Record<string, unknown>;
  const path = [fields.file_path, fields.path, fields.notebook_path].find((value) => typeof value === "string");
  const allowed = typeof path === "string" && (await allowedPath(root, path)) !== undefined;
  const reason =
    typeof path === "string"
      ? `${path} is outside your checkout, or under .git or node_modules`
      : `${toolName}: ${NO_SHELL}`;
  return { type: "tool-approval-response" as const, approvalId, approved: allowed, ...(!allowed && { reason }) };
}

/** Commits what the turn changed in the draft (every path git sees changed); whether it committed anything. */
async function commitTurn(draft: Draft, principal: Principal, message: string): Promise<boolean> {
  const { stdout } = await git("git", ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], {
    cwd: draft.root,
  });
  const paths = stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  return (await draft.commit({ paths, message, author: principal.id })) !== undefined;
}
