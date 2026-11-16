import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import {
  type Box,
  type CheckResult,
  IMAGE_AGENTS,
  type OwnAgent,
  type Principal,
  type Process,
} from "sanoma/workflows";
import { AGENTS as AGENTS_GROUP, errorMessage, isVisitor } from "sanoma/workflows/shared";
import { createUIMessageStream, generateId, type UIMessageStreamWriter } from "ai";
import { type ChatMessage, type SignInCard, textOf } from "../../lib/chat.ts";
import { homeOf, OWN_AGENTS_DIR, personBox } from "./box-session.ts";
import { boxTurn, carryIn, carryOut, checkIn } from "./carrier.ts";
import {
  agentOn,
  mustAllow,
  openDraft,
  type RealPaths,
  realIn,
  showCommits,
  type TurnAgent,
  turnMessage,
} from "./checkout.ts";
import { harnessInstructions } from "./prompt.ts";
import type { Engine, EngineTurn } from "./transcript.ts";

// The chat's third engine: a person's own coding agent, driven over the Agent Client Protocol by
// this client of ours, in the box's clone of the chat's draft, on that person's own subscription.
// The agent runs in the person's box (`personBox`, the harness engine's too) with `.acp` under the
// box's home as its HOME (`OWN_AGENTS_DIR`, out of a company-key session's reach), installed on
// first use there (`.acp/<agent>`) unless the box's image carries it (`IMAGE_AGENTS`), so a sign-in
// lives in the box and nowhere else, and nothing of ours reads it (on the local backend a box is a
// directory of this machine and every person's agent runs as its user: what an agent runs itself
// can reach other people's). One process per turn: the box opened (one turn in it at a time), the
// chat's draft carried into its clone (`carryIn`), the agent started there, told the chat's earlier
// messages as text, prompted, killed, what it changed committed in the box and carried back
// (`carryOut`) and checked there (`checkIn`), the box stopped.
// The box is its boundary: every permission request it makes is approved, and the commands it runs
// through our terminal are its own, in the box. What this process does for it, its `fs/*` reads and
// writes and a terminal's working directory, stays in the clone by the checkout rule. A sign-in it
// asks for is shown in the chat as the vendor's own flow.

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

/** How often, at most, the card shows what a vendor's sign-in printed, in ms. */
const CARD_EVERY = 250;

/** Why a turn or its sign-in ended early: the person sent another message. */
const STOPPED = "a new message stopped it";

/** A shim's refusal: what it says, and its exit. */
const refusal = (name: string) => `echo "${name} is not available to a person's own agent in Sanoma" >&2\nexit 1\n`;

/** A shim that only refuses. */
const refusing = (name: string) => `#!/bin/sh\n${refusal(name)}`;

/**
 * Commands of the box the agent and what it starts must not reach (a vendor CLI's token, the
 * Keychain, a browser), each a shim of ours first on its `PATH`. To the agent the Keychain is there
 * and empty, and takes nothing: `security` answers a lookup or a removal as macOS does for an item
 * it does not hold (44), and refuses the rest. So Claude Code keeps its sign-in in its own file
 * under the person's home, as on Linux: a lookup refused (or no `security` at all) is to it a
 * Keychain it cannot read, and it saves nothing ("Couldn't save your login"). Each script starts
 * with its shell: `security` is bash's, for its bounded `read` (macOS's sh is bash, Linux's is not).
 */
const SHIMS: Record<string, string> = {
  gh: refusing("gh"),
  open: refusing("open"),
  "xdg-open": refusing("xdg-open"),
  security: `#!/bin/bash
while [ "$1" = -q ] || [ "$1" = -v ]; do shift; done
command=$1
# Its command on stdin (one line, as Claude Code writes it), read before the answer so its writer
# sees no broken pipe, and for at most 5 s so a writer that waits for a prompt is refused, not hung.
[ "$1" = -i ] && read -r -t 5 command _ 2>/dev/null
case "$command" in
  find-generic-password | delete-generic-password)
    echo "security: The specified item could not be found in the keychain." >&2
    exit 44 ;;
esac
${refusal("security")}`,
};

/** What a vendor's sign-in printed as it failed, in words for the card after the agent's name; the first that matches. */
const SIGN_IN_FAILURES: [said: RegExp, words: string][] = [
  // Claude Code's: its store refused the token (on macOS, the Keychain through `security`).
  [/Couldn['’]t save your login/, "could not save its sign-in on this computer"],
];

/** Each agent's install under way, by its box and directory: this process's cache, so two turns install it once. */
const installs = new Map<string, Promise<void>>();

/** The engine for the agent `id` (`acp-<id>`): a turn of a chat through that person's own agent. */
export const acpEngine =
  (id: string): Engine =>
  (turn) =>
    createUIMessageStream<ChatMessage>({
      onError: errorMessage,
      execute: ({ writer }) => runTurn(agentOn(turn.step.resolved, id, "own"), turn, writer),
    });

/** Whether `principal` is a person: not an agent, nor acting for someone, nor a visitor. Only a person's own plan is spent. */
const isPerson = (principal: Principal) =>
  !isVisitor(principal) && !principal.groups?.includes(AGENTS_GROUP) && principal.onBehalfOf === undefined;

async function runTurn(agent: TurnAgent<"own">, engineTurn: EngineTurn, writer: UIMessageStreamWriter<ChatMessage>) {
  const { step, chat, messages } = engineTurn;
  const { by: principal, signal } = step;
  if (!isPerson(principal)) {
    throw new Error(`${agent.title} runs on a person's own plan, and ${principal.id} is not a person`);
  }
  // Chosen before the draft opens: a live instance that declares no box refuses the turn.
  const person = await personBox(step);
  const draft = await openDraft(step, chat);
  writer.write({ type: "start", messageId: generateId() });
  const relay = new Relay(writer);
  /** Whether the box was opened, whether its commits reached the draft, and their check in the box. */
  let opened = false;
  let carried = false;
  let checked: CheckResult | undefined;
  try {
    // Opened last, so that nothing that fails before leaves it running; stopped however the turn ends.
    carried = await boxTurn(person.name, person.open, async (box) => {
      opened = true;
      let turn: AcpTurn | undefined;
      /** The draft's head the box's clone was given, once it was. */
      let since: string | undefined;
      try {
        const boxHome = await homeOf(box);
        // The person's own agents' HOME, kept across turns in the box: their installs and sign-ins.
        const home = join(boxHome, OWN_AGENTS_DIR);
        // A first install under way is waited for even by a new message (it has a time limit of its
        // own): the box's stop would end it.
        const [cloned, installed, shimmed] = await Promise.allSettled([
          carryIn(box, step.source, chat.id, { home: boxHome, signal }),
          install(box, agent, home),
          shims(box, home),
        ]);
        if (cloned.status === "rejected") throw cloned.reason;
        if (installed.status === "rejected") throw installed.reason;
        if (shimmed.status === "rejected") throw shimmed.reason;
        since = cloned.value.head;
        turn = new AcpTurn(agent, relay, signal, {
          box,
          chatId: chat.id,
          onCode: step.onCode,
          // The draft's clone in the box.
          root: cloned.value.root,
          home,
          shimsDir: shimmed.value,
          bins: join(installed.value, "node_modules", ".bin"),
        });
        const instructions = harnessInstructions(step, principal, chat, messages.slice(0, -1));
        await turn.run(`${instructions}\n\n${principal.id}: ${textOf(messages.at(-1)!)}`);
      } catch (err) {
        // A dead or missing agent is said in the reply; a stopped turn says nothing.
        if (!signal.aborted) relay.say(`${agent.title} could not answer: ${errorMessage(err)}`);
      } finally {
        await turn?.stop();
      }
      relay.finish();
      // What it changed in the clone, committed there and carried back to the draft, then checked
      // there, unless a new message stopped the turn: its own turn checks.
      if (since === undefined) return false;
      const message = turnMessage(engineTurn, agent.title);
      const moved = await carryOut(box, step.source, chat.id, { since, message, author: principal.id });
      if (moved && !signal.aborted) checked = await checkIn(box, { signal });
      return moved;
    });
  } catch (err) {
    if (opened) throw err;
    // A box that would not open, or that runs another turn: said in the reply, as a dead agent is.
    if (!signal.aborted) relay.say(`${agent.title} could not answer: ${errorMessage(err)}`);
    relay.finish();
  } finally {
    // Shown once the box is free: the turn's error, if any, follows the card.
    if (carried) await showCommits(engineTurn, draft, writer, checked);
  }
  writer.write({ type: "finish" });
}

/** A turn's agent in the box and what it asked for: one ACP connection, its terminals and its sign-in. */
class AcpTurn {
  readonly agent: TurnAgent<"own">;
  readonly relay: Relay;
  readonly signal: AbortSignal;
  readonly box: Box;
  /** Real paths in the box, where the checkout rule checks the agent's. */
  readonly real: RealPaths;
  readonly chatId: string;
  /** Takes the codes the person pastes for this turn (`ChatTurnContext.onCode`). */
  readonly onCode: (listener: (code: string) => void) => () => void;
  /** The draft's checkout in the box: where the agent works. */
  readonly root: string;
  /** The agent's HOME: `.acp` under the box's home. */
  readonly home: string;
  /** The shims' directory and the install's bins: first on the `PATH` of everything the turn runs. */
  readonly shimsDir: string;
  readonly bins: string;
  /** Every process the turn started (the agent, its terminals, a sign-in), killed when it ends. */
  readonly #started = new Set<Started>();
  /** Whether `stop` was called: a process started after it is killed at once. */
  #stopped = false;
  readonly #terminals = new Map<string, Started>();

  constructor(
    agent: TurnAgent<"own">,
    relay: Relay,
    signal: AbortSignal,
    {
      box,
      chatId,
      onCode,
      root,
      home,
      shimsDir,
      bins,
    }: {
      box: Box;
      chatId: string;
      onCode: (listener: (code: string) => void) => () => void;
      root: string;
      home: string;
      shimsDir: string;
      bins: string;
    },
  ) {
    this.agent = agent;
    this.relay = relay;
    this.signal = signal;
    this.box = box;
    this.real = realIn(box);
    this.chatId = chatId;
    this.onCode = onCode;
    this.root = root;
    this.home = home;
    this.shimsDir = shimsDir;
    this.bins = bins;
  }

  /** Starts the agent, opens a session in the draft and prompts it with `text`; a sign-in it asks for instead is the card. */
  async run(text: string) {
    if (this.signal.aborted) return;
    const child = await this.#start(commandLine(join(this.bins, this.agent.bin), this.agent.args), { protocol: true });
    // Stopped while it started: `stop` kills it.
    if (this.signal.aborted) return;
    // Its stdout's end waits for its exit, so the connection sees how it ended first.
    const stdout = child.process.stdout.pipeThrough(new TransformStream({ flush: () => child.exited.then(() => {}) }));
    const connection = this.#client().connect(acp.ndJsonStream(child.process.stdin, stdout));
    const died = (exitCode: number) => new Error(`it stopped (${exitText(exitCode)})${tail(child.output())}`);
    // A dead agent fails what waits on it, not a hang (its stdout ends only after this).
    void child.exited.then((exitCode) => connection.close(died(exitCode)));
    const { agent } = connection;
    let sessionId: string | undefined;
    let grace: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (sessionId !== undefined) void agent.notify("session/cancel", { sessionId }).catch(() => {});
      grace = setTimeout(() => child.process.kill(), CANCEL_GRACE);
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
    } finally {
      clearTimeout(grace);
      this.signal.removeEventListener("abort", cancel);
    }
  }

  /** Kills every process the turn started, and waits for them to go, so nothing writes after the commit. */
  async stop() {
    this.#stopped = true;
    const started = [...this.#started];
    this.#started.clear();
    for (const process of started) process.process.kill();
    await Promise.all(started.map((process) => process.exited));
  }

  /**
   * `line` run in the box by `bash` (in the draft unless `cwd` says), with the box's environment and
   * `env`, the shims and the install's bins first on its `PATH`.
   */
  async #start(
    line: string,
    {
      cwd = this.root,
      env,
      stdin,
      protocol,
      limit,
    }: { cwd?: string; env?: Record<string, string>; stdin?: boolean; protocol?: boolean; limit?: number } = {},
  ) {
    const path = `${quote(this.shimsDir)}:${quote(this.bins)}:"$PATH"`;
    const process = await this.box.run(`export PATH=${path}\n${line}`, {
      cwd,
      env: { HOME: this.home, ...env },
      stdin: stdin || protocol,
    });
    const started = new Started(process, { protocol, limit });
    if (this.#stopped) {
      // The turn ended while it was starting: nothing may write after the commit.
      process.kill();
      await started.exited;
      throw new Error("The turn has ended");
    }
    this.#started.add(started);
    return started;
  }

  /** This turn's ACP client: its answers to what the agent asks. */
  #client() {
    return acp
      .client({ name: "sanoma" })
      .onNotification("session/update", ({ params }) => this.relay.update(params.update))
      .onRequest("session/request_permission", ({ params }) => this.#permit(params))
      .onRequest("fs/read_text_file", async ({ params }) => {
        const full = await this.#allowed(params.path);
        const bytes = await this.box.read(full);
        if (bytes === null) throw acp.RequestError.resourceNotFound(full);
        const text = utf8.decode(bytes);
        if (params.line == null && params.limit == null) return { content: text };
        const from = Math.max(0, (params.line ?? 1) - 1);
        const lines = text.split("\n");
        return { content: lines.slice(from, params.limit == null ? undefined : from + params.limit).join("\n") };
      })
      .onRequest("fs/write_text_file", async ({ params }) => {
        await this.box.write(await this.#allowed(params.path), utf8.encode(params.content));
        return {};
      })
      .onRequest("terminal/create", async ({ params }) => {
        const cwd = params.cwd ? await this.#allowed(params.cwd) : this.root;
        const env = Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value]));
        // A command line with no arguments is bash's to read, as an agent's shell tool writes one.
        const line = params.args?.length ? commandLine(params.command, params.args) : params.command;
        const terminal = await this.#start(line, { cwd, env, limit: params.outputByteLimit ?? undefined });
        const terminalId = generateId();
        this.#terminals.set(terminalId, terminal);
        return { terminalId };
      })
      .onRequest("terminal/output", ({ params }) => {
        const terminal = this.#terminal(params.terminalId);
        const { exitCode } = terminal;
        return {
          output: terminal.output(),
          truncated: terminal.truncated,
          exitStatus: exitCode === undefined ? null : { exitCode },
        };
      })
      .onRequest("terminal/wait_for_exit", async ({ params }) => ({
        exitCode: await this.#terminal(params.terminalId).exited,
      }))
      .onRequest("terminal/kill", ({ params }) => {
        this.#terminal(params.terminalId).process.kill();
        return {};
      })
      .onRequest("terminal/release", ({ params }) => {
        this.#terminal(params.terminalId).process.kill();
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
   * A permission request, of any kind, approved: the agent runs in its box, which is the boundary.
   * The `allow_once` it offered, else its `allow_always` (a tool that offers only that); a request
   * that offers no way to allow it, its `reject_once`, so the turn goes on, else a cancel.
   */
  #permit({ options }: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const [chosen] = ["allow_once", "allow_always", "reject_once"].flatMap((kind) =>
      options.filter((o) => o.kind === kind),
    );
    return { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } };
  }

  /** `path` as the checkout rule allows it in the draft, on the box's files; a request error naming it otherwise. */
  #allowed(path: string): Promise<string> {
    return mustAllow(this.root, path, this.real).catch((err: Error) => {
      throw acp.RequestError.invalidParams(undefined, err.message);
    });
  }

  #terminal(id: string): Started {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw acp.RequestError.invalidParams(undefined, `No terminal ${id}`);
    return terminal;
  }

  /** Writes the sign-in card, in place. */
  #card(card: Omit<SignInCard, "agent">) {
    this.relay.writer.write({ type: "data-signIn", id: "sign-in", data: { agent: this.agent.title, ...card } });
  }

  /**
   * The agent answered "sign in" (-32000): the card, and the vendor's own sign-in, which is the
   * person's. A terminal method is run by us with piped stdio, what it prints relayed into the
   * card, and a code the person pastes on the card written to its stdin; a URL elicitation is the
   * card's link and code; a vendor whose sign-in needs a real terminal gets the command to run
   * once on this computer. The card waits for its person and then says they are signed in, and the
   * chat sends their last message again by itself. The app never opens the link, enters a code or
   * reads what the vendor gives back.
   */
  async #signIn(agent: acp.ClientContext, methods: acp.AuthMethod[]) {
    const { signIn, title } = this.agent;
    if ("once" in signIn) {
      const { bin, args, after } = signIn.once;
      const command = `HOME=${quote(this.home)} ${quoted([join(this.bins, bin), ...args])}`;
      this.#card({ state: "once", command, ...(after && { after }) });
      return;
    }
    this.#card({ state: "waiting" });
    try {
      if ("authenticate" in signIn) {
        await this.#waiting(agent.request("authenticate", { methodId: signIn.authenticate }));
      } else if ("run" in signIn) {
        await this.#login(signIn.run);
      } else {
        const method = methods.find(
          (m): m is acp.AuthMethodTerminal => m.id === signIn.method && "type" in m && m.type === "terminal",
        );
        if (!method) throw new Error(`${title} offers no sign-in ${signIn.method}`);
        await this.#login(method.args ?? [], method.env);
      }
      this.#card({ state: "done" });
    } catch (err) {
      // What the vendor printed is not kept: its code is the person's.
      this.#card({ state: "failed", text: this.signal.aborted ? STOPPED : errorMessage(err) });
    }
  }

  /** Runs the agent's sign-in with `args`, relaying what it prints (now and then) and taking a code pasted on the card. */
  async #login(args: readonly string[], env?: Record<string, string>) {
    const login = await this.#start(commandLine(join(this.bins, this.agent.bin), args), { env, stdin: true });
    let shown = "";
    let timer: NodeJS.Timeout | undefined;
    const show = () => {
      timer = undefined;
      const text = stripVTControlCharacters(login.output()).trim();
      const url = text.match(/https:\/\/[^\s"'<>]+/g)?.at(-1);
      const card: Omit<SignInCard, "agent"> = {
        state: "waiting",
        text,
        ...(url && { url }),
        ...(/paste .*code/i.test(text) && { asks: true }),
      };
      if (JSON.stringify(card) === shown) return;
      shown = JSON.stringify(card);
      this.#card(card);
    };
    login.onOutput = () => {
      timer ??= setTimeout(show, CARD_EVERY);
    };
    const forget = this.onCode((code) => login.write(`${code}\n`));
    try {
      const exit = await this.#waiting(login.exited);
      if (exit !== 0) {
        // The card says what happened in words where the vendor's message is known, and how it exited
        // otherwise; the exit is this machine's log's either way.
        console.error(`sanoma app: ${this.agent.title}'s sign-in in chat ${this.chatId} stopped (${exitText(exit)})`);
        const printed = stripVTControlCharacters(login.output());
        const words = SIGN_IN_FAILURES.find(([said]) => said.test(printed))?.[1];
        throw new Error(words ? `${this.agent.title} ${words}` : `it stopped (${exitText(exit)})`);
      }
    } finally {
      clearTimeout(timer);
      forget();
      login.process.kill();
    }
  }

  /** `promise`, unless the turn stops or the person is away longer than the card waits. */
  #waiting<T>(promise: Promise<T>): Promise<T> {
    return untilAborted(promise, this.signal, { ms: SIGN_IN_WAIT, text: "nobody signed in within 15 minutes" });
  }
}

/** A tool call as the chat shows it: its name, title and input as last said, and whether it ended. */
interface Step {
  toolName: string;
  title?: string;
  input: unknown;
  ended: boolean;
}

/** The most of a step's output the chat keeps, in characters. */
const OUTPUT_LIMIT = 4_000;

/** The agent's session updates as the chat's UI message parts: text, reasoning, and its tool calls as dynamic tool parts. */
class Relay {
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

  /** A text part of the reply, whole. */
  say(text: string) {
    this.#chunk("text", text);
    this.end();
  }

  /** Ends the reply: its text or reasoning, and each step the agent left unfinished, as stopped. */
  finish() {
    this.end();
    for (const [toolCallId, step] of this.#steps) {
      if (step.ended) continue;
      step.ended = true;
      this.writer.write({
        type: "tool-output-error",
        toolCallId,
        errorText: "It stopped before it finished",
        dynamic: true,
      });
    }
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
      const errorText = textOfContent(update.content) || "It failed";
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

const quote = (word: string) => (/^[\w./=:@%-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** `words` as a command line for a shell. */
const quoted = (words: readonly string[]) => words.map(quote).join(" ");

/** `command` and `args` as one command line for `bash`, which it `exec`s. */
const commandLine = (command: string, args: readonly string[]) => `exec ${quoted([command, ...args])}`;

/** How a process ended, as a reply says it. */
const exitText = (exitCode: number) => `exit code ${exitCode}`;

/**
 * The directory that holds `agent`'s install in `box`: the image's (`IMAGE_AGENTS`) when its
 * `installed.json` is the packages wanted, which installs nothing; else `<home>/<agent>`, installed
 * there once: its packages at their versions by the `pnpm` on the box's `PATH`, as the HarnessAgent
 * bridges run it (the desktop shell ships no npm), with `home`, the agents' HOME, as its `HOME`, so
 * pnpm's store and config are theirs, in the box, outside the company's workspace, and with no
 * install script run but the vendor's own `setup`, as `installed.json` records; stopped after
 * `INSTALL_WAIT`. The last install's `node_modules` goes first: pnpm refuses one made from another
 * store (the repo moved) or by another major version. Another turn waits for an install under
 * way; a failed one is tried again by the next.
 */
export async function install(box: Box, agent: OwnAgent & { id: string }, home: string): Promise<string> {
  const wanted = JSON.stringify(agent.packages);
  const holds = async (at: string) => {
    const found = await box.read(join(at, "installed.json"));
    return found !== null && utf8.decode(found) === wanted;
  };
  const image = join(IMAGE_AGENTS, agent.id);
  const dir = join(home, agent.id);
  const [inImage, inHome] = await Promise.all([holds(image), holds(dir)]);
  if (inImage) return image;
  if (inHome) return dir;
  const key = `${box.id} ${dir}`;
  let running = installs.get(key);
  if (!running) {
    running = (async () => {
      await box.write(join(dir, "package.json"), utf8.encode('{ "private": true }\n'));
      const pnpm = ["add", "--ignore-scripts", "--ignore-workspace", "--loglevel=error", ...agent.packages];
      // As its agent's HOME, so pnpm's store and config are theirs; stopped if it hangs.
      const options = { env: { HOME: home }, signal: AbortSignal.timeout(INSTALL_WAIT) };
      await ran(box, `rm -rf node_modules && ${commandLine("pnpm", pnpm)}`, { cwd: dir, ...options });
      if (agent.setup) {
        const setup = join(dir, agent.setup);
        await ran(box, commandLine("node", [basename(setup)]), { cwd: dirname(setup), ...options });
      }
      await box.write(join(dir, "installed.json"), utf8.encode(wanted));
    })();
    installs.set(key, running);
    void running.then(
      () => installs.delete(key),
      () => installs.delete(key),
    );
  }
  await running;
  return dir;
}

/** A file's text in the box, as `BoxSession` reads it too, and back. */
const utf8 = {
  encode: (text: string) => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
};

/** Runs `line` in `box` with `options`: an error with the end of what it printed unless it exits 0. */
const ran = async (box: Box, line: string, options: Parameters<Box["run"]>[1]) =>
  new Started(await box.run(line, options)).done();

/** `promise`, or a failure when the turn stops or `timeout` passes first; `promise` goes on. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, timeout: { ms: number; text: string }): Promise<T> {
  return new Promise<T>((done, fail) => {
    if (signal.aborted) return fail(new Error(STOPPED));
    const end = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      settle();
    };
    const stop = () => end(() => fail(new Error(STOPPED)));
    const timer = setTimeout(() => end(() => fail(new Error(timeout.text))), timeout.ms);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => end(() => done(value)),
      (err: unknown) => end(() => fail(err)),
    );
  });
}

/**
 * The shims' directory (`shims` under the agents' `home`), first on the agent's PATH: each of
 * `SHIMS`, so nothing of the box's signs the agent in. Written each turn by one command, so a box
 * that lost them gets them again, each aside and then moved into place: another turn's agent may be
 * running one now.
 */
export async function shims(box: Box, home: string): Promise<string> {
  const dir = join(home, "shims");
  const aside = `.${generateId()}`;
  const written = Object.entries(SHIMS).map(
    ([name, script]) =>
      `cat > ${name}${aside} <<'SANOMA_SHIM'\n${script}SANOMA_SHIM\nchmod 755 ${name}${aside} && mv -f ${name}${aside} ${name}`,
  );
  await ran(box, [`mkdir -p ${quote(dir)} && cd ${quote(dir)}`, ...written].join(" &&\n"), {});
  return dir;
}

/** How long an agent's install may take before it is stopped, in ms. */
const INSTALL_WAIT = 10 * 60_000;

/** The most of a process's output kept when it is given no limit, in bytes. */
const OUTPUT_KEPT = 1 << 20;

/** How long a process's last output may take to be kept after it exits, in ms. */
const PIPES_WAIT = 200;

/**
 * A process started in the box (`Box.run`), what it prints kept (the last `limit` bytes, from a
 * character's start), or, as a `protocol`, its stdin and stdout left to the caller and only its
 * stderr kept. An ACP agent, a terminal it asks for, a vendor's sign-in, an install.
 */
class Started {
  readonly process: Process;
  /** Resolves to its exit code once it has exited. */
  readonly exited: Promise<number>;
  /** Its exit code, once it has exited. */
  exitCode?: number;
  /** The most of its output kept, in bytes. */
  readonly limit: number;
  /** Called whenever it prints. */
  onOutput?: () => void;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  #kept = 0;
  #dropped = false;
  #text?: string;

  constructor(process: Process, { protocol, limit }: { protocol?: boolean; limit?: number } = {}) {
    this.process = process;
    this.limit = limit ?? OUTPUT_KEPT;
    const keep = (stream: ReadableStream<Uint8Array>) =>
      stream.pipeTo(new WritableStream({ write: (chunk) => this.#print(chunk) })).catch(() => {});
    const kept = Promise.all([keep(process.stderr), protocol || keep(process.stdout)]);
    // Exited once what it printed last has been kept too, or a moment after its exit when what it
    // left running holds its output open.
    this.exited = process.wait().then(async ({ exitCode }) => {
      await Promise.race([kept, new Promise((done) => setTimeout(done, PIPES_WAIT).unref())]);
      return (this.exitCode = exitCode);
    });
  }

  #print(chunk: Uint8Array) {
    this.#chunks.push(chunk);
    this.#kept += chunk.length;
    this.#text = undefined;
    // Whole chunks past the limit go now; `output` cuts the rest to it.
    while (this.#chunks.length > 1 && this.#kept - this.#chunks[0]!.length >= this.limit) {
      this.#kept -= this.#chunks.shift()!.length;
      this.#dropped = true;
    }
    this.onOutput?.();
  }

  /** Whether output was dropped to keep within `limit`. */
  get truncated() {
    return this.#dropped || this.#kept > this.limit;
  }

  /** What it printed and was kept, as text. */
  output = () => {
    if (this.#text !== undefined) return this.#text;
    const kept = Buffer.concat(this.#chunks);
    let start = Math.max(0, kept.length - this.limit);
    // Not from the middle of a character: past its continuation bytes.
    while (start < kept.length && start > 0 && (kept[start]! & 0xc0) === 0x80) start++;
    return (this.#text = kept.subarray(start).toString("utf8"));
  };

  /** Writes `text` to its stdin, when it was given one. */
  write(text: string) {
    this.#writer ??= this.process.stdin.getWriter();
    void this.#writer.write(utf8.encode(text)).catch(() => {});
  }

  /** Resolves when it exits 0; an error with the end of what it printed otherwise. */
  async done(): Promise<void> {
    const exitCode = await this.exited;
    if (exitCode === 0) return;
    const said = this.output().trim().split("\n").slice(-5).join("\n");
    throw new Error(`${exitText(exitCode)}${said ? `: ${said}` : ""}`);
  }
}
