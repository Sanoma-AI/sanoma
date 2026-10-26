import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import type { Principal } from "@sanoma-ai/workflows";
import { AGENTS as AGENTS_GROUP, errorMessage, isVisitor } from "@sanoma-ai/workflows/shared";
import { createUIMessageStream, generateId, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import { ApiError } from "../../api.ts";
import { type ChatMessage, pathOf, type SignInCard, textOf } from "../../lib/chat.ts";
import { type ActorContext, parse, requireActor, toApiError } from "../core.ts";
import { allowedPath, commitTurn, drafting, NO_SHELL, openDraft } from "./checkout.ts";
import { Command, type Exit, sessionEnv } from "./local-session.ts";
import { harnessInstructions } from "./prompt.ts";
import { chatResponse, type Engine, type EngineTurn } from "./transcript.ts";

// The chat's third engine: a person's own coding agent, driven over the Agent Client Protocol by
// this client of ours, in the chat's draft, on that person's own subscription. The agent is a child
// of the app (its ACP entry, installed on first use under `.sanoma/agent-home/acp/<agent>`), with
// an explicit environment whose HOME is the person's own (`.sanoma/agent-home/people/<id>`), so a
// sign-in lives there, never the company's, and nothing of ours reads it (every person's agent runs
// as this machine's user: what an agent runs itself can reach other people's). One child per turn:
// started, told the chat's earlier messages as text, prompted, killed. Its permission requests,
// file reads and writes are answered by the checkout rule; the commands it runs through our
// terminal are its own. A sign-in it asks for is shown in the chat as the vendor's own flow.

/** How a person signs in to their agent from the chat. */
type SignIn =
  /** The agent's own bin with these arguments, run by us with piped stdio, what it prints relayed into the card. */
  | { run: readonly string[] }
  /** The agent's terminal sign-in method of this id (`authMethods`, `type: "terminal"`): its own bin with the method's arguments, run as `run` is. */
  | { method: string }
  /** `authenticate` with this method: the agent sends the vendor's link and code as a URL elicitation. */
  | { authenticate: string }
  /** No sign-in through the chat (the vendor's needs a real terminal): the person runs this bin of the install once on this computer. */
  | { once: { bin: string; args: readonly string[]; after?: string } };

/** A person's own coding agent, by its ACP entry. */
interface OwnAgent {
  /** The vendor's name for it. */
  title: string;
  /** What is installed for it, each at the version it was tried with (`npm install --ignore-scripts`). */
  packages: readonly string[];
  /** The install's script to run once installed: the vendor's own `postinstall`, which the install skips. */
  setup?: string;
  /** Its ACP entry: a bin of the install (`node_modules/.bin`), and its arguments. */
  bin: string;
  args: readonly string[];
  signIn: SignIn;
}

/**
 * The agents, by the name their engine takes (`acp-<name>`), with the versions spike S3 ran
 * (2026-10-25). Claude Code and Codex wait on their vendors' terms for a hosted instance
 * (`OWN_AGENTS_UNSETTLED`).
 */
export const OWN_AGENTS = {
  copilot: {
    title: "Copilot",
    packages: ["@github/copilot@1.0.103"],
    bin: "copilot",
    args: ["--acp"],
    // Its advertised method (`copilot login`) opens a browser on this machine; the device flow prints a link and a code.
    signIn: { run: ["login", "--device-code"] },
  },
  opencode: {
    title: "OpenCode",
    packages: ["opencode-ai@1.19.4"],
    setup: "node_modules/opencode-ai/postinstall.mjs",
    bin: "opencode",
    args: ["acp"],
    // Its free models need no sign-in; `auth login` prints nothing without a terminal.
    signIn: { once: { bin: "opencode", args: ["auth", "login"] } },
  },
  pi: {
    title: "Pi",
    packages: ["pi-acp@0.0.34", "@earendil-works/pi-coding-agent@1.4.0"],
    bin: "pi-acp",
    args: [],
    // Its terminal method (`pi-acp --terminal-login`) starts pi's interactive terminal UI, which prints nothing to a pipe.
    signIn: { once: { bin: "pi", args: [], after: "/login" } },
  },
  "claude-code": {
    title: "Claude Code",
    packages: ["@agentclientprotocol/claude-agent-acp@0.95.0"],
    bin: "claude-agent-acp",
    args: [],
    signIn: { method: "claude-ai-login" },
  },
  codex: {
    title: "Codex",
    packages: ["@agentclientprotocol/codex-acp@2.2.2"],
    bin: "codex-acp",
    args: [],
    signIn: { authenticate: "chat-gpt-device-code" },
  },
} satisfies Record<string, OwnAgent>;

/** An agent's name, its engine's being `acp-<name>`. */
export type OwnAgentName = keyof typeof OWN_AGENTS;

/** The agents offered only with `SANOMA_OWN_AGENTS_UNSETTLED=1`: their vendors' terms for a hosted instance are not settled. */
export const OWN_AGENTS_UNSETTLED: readonly OwnAgentName[] = ["claude-code", "codex"];

/** What this client says it can do: files and terminals (ours, by the checkout rule), terminal sign-in methods, and links to show. */
const CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
  elicitation: { url: {} },
  _meta: { "terminal-auth": true },
};

/** JSON-RPC's "authentication required", which every agent answers before it is signed in. */
const SIGN_IN_REQUIRED = -32000;

/** How long a sign-in card waits for its person. */
const SIGN_IN_WAIT = 15 * 60_000;

/** How long an agent has to stop after `session/cancel` before it is killed. */
const CANCEL_GRACE = 3_000;

/** How long a failed turn waits to see whether its agent exited, to say so. */
const EXIT_WAIT = 1_000;

/** Commands on this machine the agent and what it starts must not reach: a vendor CLI's token, the Keychain, a browser. */
const SHIMS = ["gh", "security", "open", "xdg-open"];

/** Each agent's install under way or done, by its directory. */
const installs = new Map<string, Promise<void>>();

/** The sign-ins waiting for a code their person pastes back, by chat id. */
const pasting = new Map<string, { person: string; paste: (code: string) => void }>();

/** The engine for `name`: a turn of a chat through that person's own agent, its transcript written as it goes. */
export const acpEngine =
  (name: OwnAgentName): Engine =>
  async (turn) => {
    const stream = createUIMessageStream<ChatMessage>({
      onError: errorMessage,
      execute: ({ writer }) => runTurn(name, turn, writer),
    });
    return chatResponse(turn.app, turn.chat, stream);
  };

/** Whether `principal` is a person: not an agent, nor acting for someone, nor a visitor. Only a person's own plan is spent. */
const isPerson = (principal: Principal) =>
  !isVisitor(principal) && !principal.groups?.includes(AGENTS_GROUP) && principal.onBehalfOf === undefined;

async function runTurn(
  name: OwnAgentName,
  { app, chat, messages, principal, signal }: EngineTurn,
  writer: UIMessageStreamWriter<ChatMessage>,
) {
  const agent: OwnAgent = OWN_AGENTS[name];
  if (!isPerson(principal)) {
    throw new Error(`${agent.title} runs on a person's own plan, and ${principal.id} is not a person`);
  }
  const repo = drafting(app);
  // Kept across restarts: the installs, and each person's sign-ins.
  const home = join(repo.root, ".sanoma", "agent-home");
  const draft = await openDraft(app, chat);
  writer.write({ type: "start", messageId: generateId() });
  const said = messages.at(-1)!;
  const turn = new AcpTurn(agent, { chatId: chat.id, person: principal.id, root: draft.root }, writer, signal);
  try {
    const dir = join(home, "acp", name);
    // A new message does not wait for a first install: it goes on, for the next turn.
    await untilAborted(install(agent, dir, home), signal);
    const personal = join(home, "people", personDir(principal.id));
    await mkdir(personal, { recursive: true });
    const env = sessionEnv(personal);
    turn.env = { ...env, PATH: [await shims(home), join(dir, "node_modules", ".bin"), env.PATH].join(":") };
    turn.install = dir;
    const instructions = harnessInstructions(app, principal, chat, messages.slice(0, -1));
    await turn.run(`${instructions}\n\n${principal.id}: ${textOf(said)}`);
  } catch (err) {
    // A dead or missing agent is said in the reply; a stopped turn says nothing.
    if (!signal.aborted) turn.relay.say(`${agent.title} could not answer: ${errorMessage(err)}`);
  } finally {
    await turn.stop();
  }
  turn.relay.end();
  await commitTurn(
    app,
    chat,
    draft,
    principal.id,
    `${agent.title}: ${textOf(said, " ").trim().slice(0, 72)}`,
    signal,
    writer,
  );
  writer.write({ type: "finish" });
}

/** A turn's child and what it asked for: one ACP connection, its terminals and its sign-in. */
class AcpTurn {
  readonly agent: OwnAgent;
  readonly chatId: string;
  readonly person: string;
  /** The draft's checkout: where the agent works. */
  readonly root: string;
  readonly writer: UIMessageStreamWriter<ChatMessage>;
  readonly signal: AbortSignal;
  readonly relay: Relay;
  /** The child's environment and its install's directory, once installed. */
  env: Record<string, string> = {};
  install = "";
  /** Every process the turn started (the agent, its terminals, a sign-in), killed when it ends. */
  readonly #commands = new Set<Command>();
  readonly #terminals = new Map<string, Command>();

  constructor(
    agent: OwnAgent,
    { chatId, person, root }: { chatId: string; person: string; root: string },
    writer: UIMessageStreamWriter<ChatMessage>,
    signal: AbortSignal,
  ) {
    this.agent = agent;
    this.chatId = chatId;
    this.person = person;
    this.root = root;
    this.writer = writer;
    this.signal = signal;
    this.relay = new Relay(writer);
  }

  /** Starts the agent, opens a session in the draft and prompts it with `text`; a sign-in it asks for instead is the card. */
  async run(text: string) {
    if (this.signal.aborted) return;
    const child = this.#start(join(this.install, "node_modules", ".bin", this.agent.bin), this.agent.args, {
      protocol: true,
    });
    const connection = this.#client().connect(acp.ndJsonStream(child.stdin!, child.stdout!));
    const died = (exit: Exit) =>
      new Error(`it stopped (${exit.signal ?? `exit code ${exit.exitCode}`})${tail(child.output())}`);
    // A dead child fails what waits on it, not a hang.
    void child.exited.then((exit) => connection.close(died(exit)));
    const { agent } = connection;
    let sessionId: string | undefined;
    const cancel = () => {
      if (sessionId !== undefined) void agent.notify("session/cancel", { sessionId }).catch(() => {});
      setTimeout(() => child.kill(), CANCEL_GRACE).unref();
    };
    this.signal.addEventListener("abort", cancel, { once: true });
    try {
      const init = await agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: CAPABILITIES,
        clientInfo: { name: "sanoma", title: "Sanoma", version: "1" },
      });
      try {
        ({ sessionId } = await agent.request("session/new", { cwd: this.root, mcpServers: [] }));
        const { stopReason } = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        if (stopReason !== "end_turn" && stopReason !== "cancelled") {
          this.relay.say(`${this.agent.title} stopped: ${stopReason.replaceAll("_", " ")}`);
        }
      } catch (err) {
        const { code, data } = err as { code?: unknown; data?: { authMethods?: acp.AuthMethod[] } };
        if (code !== SIGN_IN_REQUIRED || this.signal.aborted) throw err;
        // Some agents list their methods only with the error.
        await this.#signIn(agent, [...(init.authMethods ?? []), ...(data?.authMethods ?? [])]);
      }
    } catch (err) {
      // Its output closes the connection before its exit is seen: how it died, when it did.
      const exit = await Promise.race([child.exited, delay(EXIT_WAIT)]);
      throw exit ? died(exit) : err;
    } finally {
      this.signal.removeEventListener("abort", cancel);
    }
  }

  /** Kills every process the turn started, and waits (a moment at most) for them to go, so nothing writes after the commit. */
  async stop() {
    const commands = [...this.#commands];
    this.#commands.clear();
    for (const command of commands) command.kill();
    await Promise.race([Promise.all(commands.map((command) => command.exited)), delay(EXIT_WAIT)]);
  }

  /** `args` run as `command` (in the draft unless `cwd` says), with the turn's environment and `env`, in a process group of its own. */
  #start(
    command: string,
    args: readonly string[],
    {
      cwd = this.root,
      env,
      ...options
    }: { cwd?: string; env?: Record<string, string>; stdin?: boolean; protocol?: boolean } = {},
  ) {
    const started = new Command(command, args, { cwd, env: { ...this.env, ...env }, ...options });
    this.#commands.add(started);
    return started;
  }

  /** This turn's ACP client: its answers to what the agent asks. */
  #client() {
    return acp
      .client({ name: "sanoma" })
      .onNotification("session/update", ({ params }) => this.relay.update(params.update))
      .onRequest("session/request_permission", ({ params }) => this.#permit(params))
      .onRequest("fs/read_text_file", async ({ params }) => {
        const text = await readFile(await this.#allowed(params.path), "utf8");
        if (params.line == null && params.limit == null) return { content: text };
        const from = Math.max(0, (params.line ?? 1) - 1);
        const lines = text.split("\n");
        return { content: lines.slice(from, params.limit == null ? undefined : from + params.limit).join("\n") };
      })
      .onRequest("fs/write_text_file", async ({ params }) => {
        const full = await this.#allowed(params.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, params.content);
        return {};
      })
      .onRequest("terminal/create", async ({ params }) => {
        const cwd = params.cwd ? await this.#allowed(params.cwd) : this.root;
        const env = Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value]));
        // A command line with no arguments is bash's to read, as an agent's shell tool writes one.
        const [command, args] = params.args?.length ? [params.command, params.args] : ["bash", ["-c", params.command]];
        const terminal = this.#start(command, args, { cwd, env });
        terminal.limit = params.outputByteLimit ?? undefined;
        const terminalId = generateId();
        this.#terminals.set(terminalId, terminal);
        return { terminalId };
      })
      .onRequest("terminal/output", ({ params }) => {
        const terminal = this.#terminal(params.terminalId);
        return { output: terminal.output(), truncated: terminal.truncated, exitStatus: terminal.status ?? null };
      })
      .onRequest("terminal/wait_for_exit", ({ params }) => this.#terminal(params.terminalId).exited)
      .onRequest("terminal/kill", ({ params }) => {
        this.#terminal(params.terminalId).kill();
        return {};
      })
      .onRequest("terminal/release", ({ params }) => {
        this.#terminal(params.terminalId).kill();
        this.#terminals.delete(params.terminalId);
        return {};
      })
      .onRequest("elicitation/create", ({ params }) => {
        // A link to show (Codex's device code): the card, accepted as shown. A form, never advertised, is declined.
        if (params.mode !== "url" || typeof params.url !== "string") return { action: "decline" };
        this.#card({ state: "waiting", text: params.message, url: params.url });
        return { action: "accept" };
      })
      .onNotification("*", () => {})
      .onRequest("*", ({ method }) => {
        throw acp.RequestError.methodNotFound(method);
      });
  }

  /**
   * The checkout rule's answer to a permission request: an edit (a change, deletion or move) of
   * paths the rule allows in the draft gets the `allow_once` the agent offered; anything else, a
   * path outside, a command, a fetch, gets its `reject_once`, with the reason, which the step shows.
   * `allow_always` is never chosen, and only an option the agent offered is returned.
   */
  async #permit({ toolCall, options }: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const offered = (kind: acp.PermissionOptionKind) => options.find((option) => option.kind === kind);
    const refuse = (reason: string): acp.RequestPermissionResponse => {
      this.relay.refusals.set(toolCall.toolCallId, reason);
      const reject = offered("reject_once");
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId }, _meta: { reason } }
        : { outcome: { outcome: "cancelled" }, _meta: { reason } };
    };
    const kind = toolCall.kind ?? this.relay.kindOf(toolCall.toolCallId);
    if (kind === "execute") return refuse(NO_SHELL);
    if (kind !== "edit" && kind !== "delete" && kind !== "move") {
      return refuse(`${toolCall.title ?? "This tool"} is not available in this chat: edit the files in your checkout`);
    }
    const paths = [...(toolCall.locations ?? []).map((location) => location.path), pathOf(toolCall.rawInput)];
    const named = [...new Set(paths.filter((path): path is string => typeof path === "string"))];
    if (!named.length) return refuse("An edit names its file: say which file in your checkout");
    for (const path of named) {
      if ((await allowedPath(this.root, path)) === undefined) {
        return refuse(`${path} is outside your checkout, or under .git or node_modules`);
      }
    }
    const allow = offered("allow_once");
    return allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : refuse("Only an edit allowed once is accepted in this chat");
  }

  /** `path` as the checkout rule allows it in the draft; a request error naming it otherwise. */
  async #allowed(path: string): Promise<string> {
    const full = await allowedPath(this.root, path);
    if (full === undefined) {
      throw acp.RequestError.invalidParams(
        undefined,
        `${path} is outside your checkout, or under .git or node_modules`,
      );
    }
    return full;
  }

  #terminal(id: string): Command {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw acp.RequestError.invalidParams(undefined, `No terminal ${id}`);
    return terminal;
  }

  /** Writes the sign-in card, in place. */
  #card(card: Omit<SignInCard, "agent">) {
    this.writer.write({ type: "data-signIn", id: "sign-in", data: { agent: this.agent.title, ...card } });
  }

  /**
   * The agent answered "sign in" (-32000): the card, and the vendor's own sign-in, which is the
   * person's. A terminal method is run by us with piped stdio, what it prints relayed into the
   * card, and a code the person pastes on the card written to its stdin; a URL elicitation is the
   * card's link and code; a vendor whose sign-in needs a real terminal gets the command to run
   * once on this computer. The card waits for its person, then says to send the message again.
   * The app never opens the link, enters a code or reads what the vendor gives back.
   */
  async #signIn(agent: acp.ClientContext, methods: acp.AuthMethod[]) {
    const { signIn, title } = this.agent;
    this.#card({ state: "waiting" });
    try {
      if ("authenticate" in signIn) {
        await this.#waiting(agent.request("authenticate", { methodId: signIn.authenticate }));
      } else if ("once" in signIn) {
        const { bin, args, after } = signIn.once;
        const line = [
          `HOME=${quote(this.env.HOME!)}`,
          quote(join(this.install, "node_modules", ".bin", bin)),
          ...args.map(quote),
        ];
        this.#card({ state: "once", command: line.join(" "), ...(after && { after }) });
        return;
      } else {
        const method =
          "method" in signIn
            ? methods.find((m) => m.id === signIn.method && "type" in m && m.type === "terminal")
            : undefined;
        if ("method" in signIn && !method) throw new Error(`${title} offers no sign-in ${signIn.method}`);
        const args = "run" in signIn ? signIn.run : ((method as acp.AuthMethodTerminal).args ?? []);
        const env = (method as acp.AuthMethodTerminal | undefined)?.env;
        await this.#login(join(this.install, "node_modules", ".bin", this.agent.bin), args, env);
      }
      this.#card({ state: "done" });
    } catch (err) {
      // What the vendor printed is not kept: its code is the person's.
      this.#card({ state: "failed", text: this.signal.aborted ? "a new message stopped it" : errorMessage(err) });
    }
  }

  /** Runs the vendor's sign-in command, relaying what it prints and taking a code pasted on the card. */
  async #login(command: string, args: readonly string[], env?: Record<string, string>) {
    const login = this.#start(command, args, { env, stdin: true });
    const show = () => {
      const text = stripVTControlCharacters(login.output()).trim();
      const url = text.match(/https:\/\/[^\s"'<>]+/g)?.at(-1);
      this.#card({ state: "waiting", text, ...(url && { url }), ...(/paste .*code/i.test(text) && { asks: true }) });
    };
    login.onOutput = show;
    const waiting = { person: this.person, paste: (code: string) => login.write(`${code}\n`) };
    pasting.set(this.chatId, waiting);
    try {
      const { exitCode, signal } = await this.#waiting(login.exited);
      if (exitCode !== 0) throw new Error(`it stopped (${signal ?? `exit code ${exitCode}`})`);
    } finally {
      // Its own entry only: a later turn of the chat may be waiting for a code by now.
      if (pasting.get(this.chatId) === waiting) pasting.delete(this.chatId);
      login.kill();
    }
  }

  /** `promise`, unless the turn stops or the person is away longer than the card waits. */
  #waiting<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((done, fail) => {
      const stop = () => fail(new Error("a new message stopped it"));
      const timer = setTimeout(() => fail(new Error("nobody signed in within 15 minutes")), SIGN_IN_WAIT);
      this.signal.addEventListener("abort", stop, { once: true });
      promise.then(done, fail).finally(() => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", stop);
      });
    });
  }
}

/** A tool call as the chat shows it: its name, title and input as last said, and whether it ended. */
interface Step {
  toolName: string;
  title?: string;
  input: unknown;
  kind?: acp.ToolKind | null;
  ended: boolean;
}

/** The most of a step's output the chat keeps, in characters. */
const OUTPUT_LIMIT = 4_000;

/** The agent's session updates as the chat's UI message parts: text, reasoning, and its tool calls as dynamic tool parts. */
class Relay {
  /** Why the checkout rule refused a tool call, by its id: the step's error once the agent says it failed. */
  readonly refusals = new Map<string, string>();
  #open?: { type: "text" | "reasoning"; id: string };
  readonly #steps = new Map<string, Step>();

  readonly writer: UIMessageStreamWriter<ChatMessage>;

  constructor(writer: UIMessageStreamWriter<ChatMessage>) {
    this.writer = writer;
  }

  update(update: acp.SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.#chunk(update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning", update.content.text);
        }
        return;
      case "tool_call":
      case "tool_call_update":
        return this.#step(update);
    }
  }

  /** The kind a tool call said it is, for a permission request that does not repeat it. */
  kindOf = (toolCallId: string) => this.#steps.get(toolCallId)?.kind;

  /** A text part of the reply, whole. */
  say(text: string) {
    this.#chunk("text", text);
    this.end();
  }

  /** Ends the text or reasoning under way. */
  end() {
    if (!this.#open) return;
    const { type, id } = this.#open;
    this.writer.write({ type: type === "text" ? "text-end" : "reasoning-end", id });
    this.#open = undefined;
  }

  #chunk(type: "text" | "reasoning", delta: string) {
    if (this.#open?.type !== type) {
      this.end();
      this.#open = { type, id: generateId() };
      this.writer.write({ type: type === "text" ? "text-start" : "reasoning-start", id: this.#open.id });
    }
    const { id } = this.#open;
    this.writer.write(type === "text" ? { type: "text-delta", id, delta } : { type: "reasoning-delta", id, delta });
  }

  #step(update: acp.ToolCallUpdate) {
    this.end();
    const { toolCallId } = update;
    const known = this.#steps.get(toolCallId);
    if (known?.ended) return;
    const step: Step = {
      toolName: known?.toolName ?? update.name ?? update.kind ?? "tool",
      title: update.title ?? known?.title,
      input: update.rawInput ?? known?.input ?? {},
      kind: update.kind ?? known?.kind,
      ended: false,
    };
    this.#steps.set(toolCallId, step);
    if (!known || step.title !== known.title || step.input !== known.input) {
      const { toolName, title, input } = step;
      this.writer.write({
        type: "tool-input-available",
        toolCallId,
        toolName,
        input,
        dynamic: true,
        ...(title && { title }),
      });
    }
    if (update.status === "completed") {
      step.ended = true;
      this.writer.write({ type: "tool-output-available", toolCallId, output: outputOf(update), dynamic: true });
    } else if (update.status === "failed") {
      step.ended = true;
      const errorText = this.refusals.get(toolCallId) ?? (textOfContent(update.content) || "It failed");
      this.writer.write({ type: "tool-output-error", toolCallId, errorText, dynamic: true });
    }
  }
}

/** A finished tool call's output for the chat: its text, else what it changed, else its raw output; cut to the limit. */
function outputOf({ content, rawOutput }: acp.ToolCallUpdate): unknown {
  const text = textOfContent(content);
  const diffs = (content ?? []).flatMap((item) => (item.type === "diff" ? [item.path] : []));
  const output = text || (diffs.length ? `Changed ${diffs.join(", ")}` : rawOutput);
  return typeof output === "string" && output.length > OUTPUT_LIMIT
    ? `${output.slice(0, OUTPUT_LIMIT)}\n[cut]`
    : (output ?? null);
}

const textOfContent = (content: acp.ToolCallContent[] | null | undefined) =>
  (content ?? [])
    .flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : []))
    .join("\n");

/** The last line of what a child printed, for the reply's error. */
const tail = (output: string) => {
  const last = stripVTControlCharacters(output).trim().split("\n").at(-1)?.slice(0, 300);
  return last ? `: ${last}` : "";
};

/** A person's id as a directory name: never `.`, `..` or a path. */
const personDir = (id: string) => encodeURIComponent(id).replaceAll(".", "%2E");

const quote = (word: string) => (/^[\w./=:-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * Installs `agent` into `dir`, once: its packages at their versions by this Node's npm, with no
 * install script run but the vendor's own `setup`, as `installed.json` records. Another turn waits
 * for an install under way; a failed one is tried again by the next.
 */
async function install(agent: OwnAgent, dir: string, home: string): Promise<void> {
  const marker = join(dir, "installed.json");
  const wanted = JSON.stringify(agent.packages);
  if ((await readFile(marker, "utf8").catch(() => undefined)) === wanted) return;
  let running = installs.get(dir);
  if (!running) {
    running = (async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), '{ "private": true }\n');
      const env = sessionEnv(home);
      const npm = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...agent.packages];
      await new Command("npm", npm, { cwd: dir, env }).done();
      if (agent.setup)
        await new Command("node", [join(dir, agent.setup)], { cwd: dirname(join(dir, agent.setup)), env }).done();
      await writeFile(marker, wanted);
    })();
    installs.set(dir, running);
    void running.then(
      () => installs.delete(dir),
      () => installs.delete(dir),
    );
  }
  await running;
}

/** `promise`, or the turn's stop when it comes first (`promise` goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((done, fail) => {
    const stop = () => fail(new Error("a new message stopped it"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then(done, fail).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The shims' directory, first on the agent's PATH: each of `SHIMS` refuses, so nothing of this machine's user signs the agent in. */
async function shims(home: string): Promise<string> {
  const dir = join(home, "acp", "shims");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    SHIMS.map((name) =>
      writeFile(
        join(dir, name),
        `#!/bin/sh\necho "${name} is not available to a person's own agent in Sanoma" >&2\nexit 1\n`,
        {
          mode: 0o755,
        },
      ),
    ),
  );
  return dir;
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
 * `POST /api/sign-in`: the code the person pastes on their sign-in card, written to the vendor's
 * sign-in waiting in their chat (never stored or logged). A chat with none waiting, or someone
 * else's, is a 404.
 */
export async function postSignInCode(request: Request, context: ActorContext): Promise<Response> {
  try {
    const principal = await requireActor(context);
    const { chat, code } = parse(SignInCode, await request.json().catch(() => undefined), "The request");
    const waiting = pasting.get(chat);
    if (waiting?.person !== principal.id)
      throw new ApiError(404, { error: `No sign-in waits for a code in chat ${chat}` });
    waiting.paste(code);
    return new Response(null, { status: 204 });
  } catch (err) {
    const { status, body } = toApiError(err, "a sign-in code");
    return Response.json(body, { status });
  }
}
