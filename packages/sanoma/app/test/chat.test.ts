import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { defineConnector, defineDriver, isEnded, localBackend, SanomaClient, withSetup } from "sanoma/workflows";
import { createUIMessageStream, customProvider, getToolName, isToolUIPart, readUIMessageStream } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { copyFixture, ensureBuilt } from "../../test/fixture.ts";
import { gitIdentity } from "../../test/git.ts";
import { localGitSource } from "../../src/source.ts";
import { ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { takeAppPrompt } from "../src/lib/apps.ts";
import { type ChatMessage, chatTransport, isIntro } from "../src/lib/chat.ts";
import { INTRO } from "../src/server/chat.ts";
import { allowedPaths, here, realIn } from "../src/steps/agent/checkout.ts";
import { suggestedAsks } from "../src/steps/agent/transcript.ts";
import { ENGINES } from "../src/steps/agent/turn.ts";
import { appSteps } from "../src/steps/index.ts";

// Needs Postgres (`pnpm db:up`) and the built app. The chat's route, end to end, on our loop: a mock
// model (a connector's model half, as models.test.ts attaches one) that answers each request by a
// script, the sanoma package's fixture company as the repository (its own git repository, with an
// offboarding workflow), and a lookup the policy holds for a lead. Each turn is a run the test
// worker executes with the app's steps; the route streams its reply from the database. No fake
// stream layer: the route's stream as the browser's transport reads it.

/** This file's run, so its chats and held runs are new on a test database used before. */
const RUN = randomUUID().slice(0, 8);

/** What the model answers, step by step, to the person's last message. */
type Step = { tool: string; input: unknown } | { text: string };
const SCRIPT: Record<string, Step[]> = {
  "Add a laptop step to offboarding": [
    { tool: "list_files", input: { path: "workflows" } },
    { tool: "read_file", input: { path: "workflows/offboarding.ts" } },
    {
      tool: "edit_file",
      input: {
        path: "workflows/offboarding.ts",
        old: "`Removed ${person}'s accounts`",
        new: "`Removed ${person}'s accounts`, `Collected ${person}'s laptop`",
        message: "Offboarding collects the laptop",
      },
    },
    { tool: "run_checks", input: {} },
    { text: "Drafted: offboarding now collects the laptop. Merge the branch to apply it." },
  ],
  "Look up Acme": [{ tool: "lookup", input: { op: "crm.customer.find", input: { name: "Acme" } } }, { text: "Acme." }],
  "Look up Beta": [{ tool: "lookup", input: { op: "crm.customer.find", input: { name: "Beta" } } }, { text: "Beta." }],
  "Never mind": [{ text: "Fine." }],
  continue: [{ text: "Acme Ltd is a customer since 2019." }],
  [INTRO]: [
    {
      text: "Hi ada, I make the changes to chat-test. It has two workflows.\n\n**Suggested asks:**\n- Add a laptop step to offboarding\n- **Who can approve a refund?**\n\nAsk me anything.",
    },
  ],
  [takeAppPrompt("file:///srv/crm")]: [
    { tool: "take_app", input: { url: "file:///srv/crm" } },
    { text: "That source is not a public repository." },
  ],
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** The system prompts the model was given, in order. */
const systems: string[] = [];

/** The script's step for this request: the next after the assistant's messages since the person's last. */
function stepFor({ prompt }: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] {
  const system = prompt.find((m) => m.role === "system");
  if (system) systems.push(system.content);
  const last = prompt.findLastIndex((m) => m.role === "user");
  const user = prompt[last];
  const said = user?.role === "user" ? user.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
  const index = prompt.slice(last).filter((m) => m.role === "assistant").length;
  const step = SCRIPT[said]?.[index] ?? { text: `No script for "${said}" at step ${index}` };
  const start: LanguageModelV4StreamPart = { type: "stream-start", warnings: [] };
  if ("text" in step) {
    return [
      start,
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: step.text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ];
  }
  return [
    start,
    {
      type: "tool-call",
      toolCallId: `${RUN}-${said.length}-${index}`,
      toolName: step.tool,
      input: JSON.stringify(step.input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
}

const model = new MockLanguageModelV4({
  doStream: async (options) => ({ stream: simulateReadableStream({ chunks: stepFor(options) }) }),
});

const crm = defineConnector("crm", {
  customer: {
    find: {
      effect: "read",
      idempotent: true,
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string(), since: z.number() }),
    },
  },
});
const crmDriver = defineDriver(crm, { customer: { find: async ({ name }) => ({ name: `${name} Ltd`, since: 2019 }) } });

// The config's root: its people, and a policy that holds every customer lookup for `lead`.
const root = mkdtempSync(join(tmpdir(), "sanoma-chat-"));
writeFileSync(join(root, "package.json"), '{ "name": "chat-test", "private": true }\n');
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
`,
);
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "policies/crm.cedar"),
  `@hold("lead")
forbid (principal, action == Sanoma::Action::"crm.customer.find", resource);
`,
);

const testApp = useTestApp(
  {
    workflows: [],
    connectors: [
      withSetup(crm, { driver: () => crmDriver }),
      withSetup(defineConnector("mock", {}), { model: () => customProvider({ languageModels: { default: model } }) }),
    ],
    root,
  },
  { databaseUrl: testDatabaseUrl("chat") },
);

/** The fixture company, its own git repository: the source the agent drafts in. */
let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let app: App | undefined;
const start = async () =>
  (app = await startApp(testApp.config, {
    port: 0,
    source: localGitSource(dir, { databaseUrl: testApp.config.databaseUrl! }),
  }));

beforeAll(async () => {
  ensureBuilt();
  gitIdentity(vi.stubEnv);
  // No key reaches a vendor from here: the only model is the mock.
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  dir = copyFixture();
  writeFileSync(
    join(dir, "workflows/offboarding.ts"),
    `import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "offboarding",
  title: "Offboard someone",
  trigger: "manual",
  input: z.object({ person: z.string().min(1) }),
  uses: [],
  run: async (ctx, { person }) => ({ done: [\`Removed \${person}'s accounts\`] }),
});
`,
  );
  const config = join(dir, "sanoma.config.ts");
  writeFileSync(
    config,
    readFileSync(config, "utf8")
      .replace('import hello from "./workflows/hello.ts";', '$&\nimport offboarding from "./workflows/offboarding.ts";')
      .replace("workflows: [hello]", "workflows: [hello, offboarding]"),
  );
  writeFileSync(join(dir, "AGENTS.md"), "# Fixture Co\n\nOffboarding happens on the person's last day.\n");
  writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  // The worker runs the turns, in the repository.
  await testApp.restart({ source: localGitSource(dir, { databaseUrl: testApp.config.databaseUrl! }), app: appSteps });
  await start();
}, 600_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The browser's transport, the chat column's (`chatTransport`), as `actor`: only the new message is sent. */
const transport = (actor = "ada") =>
  chatTransport(new URL("/api/chat", app!.url).href, () => ({
    [ACTOR_HEADER]: actor,
    origin: new URL(app!.url).origin,
  }));

const userMessage = (text: string): ChatMessage => ({
  id: randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

/**
 * Sends `text` (or a message as it is) to the chat `id` after `history`, as useChat does, with
 * `body`'s fields: each snapshot of the reply to `onSnapshot`, and the reply as it ended. A stream
 * cut short ends the reply where it was.
 */
async function send(
  id: string,
  history: ChatMessage[],
  text: string | ChatMessage,
  onSnapshot?: (reply: ChatMessage) => void,
  body?: object,
) {
  const stream = await transport().sendMessages({
    trigger: "submit-message",
    chatId: id,
    messageId: undefined,
    messages: [...history, typeof text === "string" ? userMessage(text) : text],
    abortSignal: undefined,
    body,
  });
  let reply: ChatMessage | undefined;
  try {
    for await (const snapshot of readUIMessageStream<ChatMessage>({ stream })) {
      reply = snapshot;
      onSnapshot?.(snapshot);
    }
  } catch {
    // The server went away mid-turn: the reply as far as it came.
  }
  return reply;
}

/** The agent's cue to speak first, as the chat column sends it (`isIntro`). */
const cue = (): ChatMessage => ({ ...userMessage(""), metadata: { intro: true } });

/** The agent speaks first in the chat `id`, as the chat column asks it: the reply as it ended. */
const speak = (id: string) => send(id, [], cue(), undefined, { engine: "loop", start: true });

/** A request to the route of the app at `url`, as fetch sends it, from its own origin unless `headers` say otherwise. */
const post = (body: unknown, headers: Record<string, string> = {}, url = app!.url) =>
  fetch(new URL("/api/chat", url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify(body),
  });

/** A message's text. */
const said = (message: ChatMessage) => message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

const toolParts = (message: ChatMessage | undefined) => (message?.parts ?? []).filter(isToolUIPart);

describe("the chat", () => {
  const id = `chat-${RUN}`;

  it("drafts the change on a branch of its own, commits and checks it, and shows the draft card", async () => {
    const reply = await send(id, [], "Add a laptop step to offboarding");
    expect(toolParts(reply).map((part) => [getToolName(part), part.state])).toEqual([
      ["list_files", "output-available"],
      ["read_file", "output-available"],
      ["edit_file", "output-available"],
      ["run_checks", "output-available"],
    ]);
    expect(toolParts(reply)[0]!.output).toContain("workflows/offboarding.ts");
    const cards = reply!.parts.filter((part) => part.type === "data-draft");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.data).toEqual({
      draft: id,
      branch: `draft/${id}`,
      files: ["workflows/offboarding.ts"],
      summary: expect.stringContaining("workflows/offboarding.ts"),
      checks: { ok: true, problems: [], warnings: [] },
    });
    expect(reply!.parts.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^Drafted/) });

    // The system prompt: the rules, the company's AGENTS.md, the connectors with their effects.
    expect(systems[0]).toContain("Offboarding happens on the person's last day.");
    expect(systems[0]).toMatch(/crm.*\n.*crm\.customer\.find \(read/);

    // The change is the draft's commit; the live checkout is as it was.
    expect(git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, "workflows/offboarding.ts"), "utf8")).not.toContain("laptop");
    expect(git("log", "--format=%s", `draft/${id}`)).toBe("Offboarding collects the laptop\nFirst");
    expect(git("show", `draft/${id}:workflows/offboarding.ts`)).toContain("Collected ${person}'s laptop");

    // The chat, titled by its first message, keeps the draft and the transcript.
    const { chats } = testApp.client;
    expect(await chats.get(id)).toMatchObject({
      person: "ada",
      engine: "loop",
      draftId: id,
      title: "Add a laptop step to offboarding",
    });
    await waitFor(async () => (await chats.load(id)).length === 2);
    expect(((await chats.load(id)) as ChatMessage[]).map((m) => m.role)).toEqual(["user", "assistant"]);
  }, 300_000);

  it("shows a held lookup as its approval, and after the worker's restart settles the turn it cut short and continues", async () => {
    const { chats } = testApp.client;
    const history = (await chats.load(id)) as ChatMessage[];
    // The lookup is held: its part shows the run waiting, and the transcript keeps it as it waits.
    let runId: string | undefined;
    const turn = send(id, history, "Look up Acme", (reply) => {
      const output = toolParts(reply)[0]?.output as { held?: { runId: string } } | undefined;
      runId ??= output?.held?.runId;
    });
    await waitFor(() => runId, Boolean, 30_000);
    expect(runId).toBe(`call:ada:${id}:${RUN}-12-0`);
    await waitFor(async () => {
      const stored = (await chats.load(id)) as ChatMessage[];
      return toolParts(stored.at(-1))[0]?.output !== undefined;
    });
    expect(toolParts(((await chats.load(id)) as ChatMessage[]).at(-1))[0]).toMatchObject({
      state: "output-available",
      preliminary: true,
      output: { held: { runId } },
    });
    // The run asks for its approval as it starts.
    await waitFor(async () => (await testApp.client.approvals(runId!)).length > 0);
    expect(await testApp.client.approvals(runId!)).toEqual([
      expect.objectContaining({ approver: "lead", status: "pending" }),
    ]);
    const turnId = (await testApp.client.turn(id))!.runId;

    // The worker stops mid-turn; the lead approves; another worker takes the runs over: the turn,
    // begun already, settles what it left and runs nothing again, and the stream ends.
    await testApp.stop();
    await testApp.client.decide(runId!, { decision: "approve", by: { id: "lead" } }, undefined, { timeoutSeconds: 1 });
    await testApp.restart();
    const cut = await turn;
    expect(toolParts(cut)[0]).toMatchObject({ preliminary: true, output: { held: { runId } } });
    expect(await testApp.client.result(turnId)).toEqual({ interrupted: true });
    await waitFor(async () => isEnded((await testApp.client.run(runId!))?.status ?? "running"), Boolean, 30_000);

    // The chat reloads from its transcript, its turn cut short where it was; "continue" settles the
    // lookup from its run and picks up.
    const reloaded = (await chats.load(id)) as ChatMessage[];
    expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const reply = await send(id, reloaded, "continue");
    expect(reply!.parts.at(-1)).toMatchObject({ type: "text", text: "Acme Ltd is a customer since 2019." });
    await waitFor(async () => (await chats.load(id)).length === 6);
    const settled = toolParts(((await chats.load(id)) as ChatMessage[])[3]);
    expect(settled[0]).toMatchObject({
      state: "output-available",
      preliminary: false,
      output: { output: { name: "Acme Ltd", since: 2019 } },
    });
    // The model saw the settled lookup's result before it answered.
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain("Acme Ltd");
  }, 300_000);

  it("stops a turn under way for the person's next message, which answers once it has stopped", async () => {
    const other = `stops-${RUN}`;
    let held: string | undefined;
    const first = send(other, [], "Look up Beta", (reply) => {
      held ??= (toolParts(reply)[0]?.output as { held?: { runId: string } } | undefined)?.held?.runId;
    });
    await waitFor(() => held, Boolean, 30_000);
    const turnId = (await testApp.client.turn(other))!.runId;
    const stored = (await testApp.client.chats.load(other)) as ChatMessage[];
    const reply = await send(other, stored, "Never mind");
    expect(reply!.parts.at(-1)).toMatchObject({ type: "text", text: "Fine." });
    // The first turn ended for it: its stream too, where it was.
    expect(toolParts(await first)[0]).toMatchObject({ output: { held: { runId: held } } });
    expect((await testApp.client.run(turnId))?.status).toBe("finished");
    const roles = ((await testApp.client.chats.load(other)) as ChatMessage[]).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    // The turns' runs name the chat's messages by id: their text is the chat's person's alone.
    const next = (await testApp.client.turn(other))!.runId;
    for (const run of [turnId, next]) {
      expect(JSON.stringify(await testApp.client.ledger(run)), run).not.toMatch(/Beta|Never mind|Fine\./);
    }
  }, 300_000);

  it("keeps the conversation's order for messages sent while a turn is open: each one's history, then its reply", async () => {
    const other = `order-${RUN}`;
    const { chats } = testApp.client;
    // An engine that answers each message by its text, the first once let go (stopped or not),
    // and keeps the messages each turn was given.
    const { promise: held, resolve: letGo } = Promise.withResolvers<void>();
    const given: string[][] = [];
    vi.spyOn(ENGINES, "loop").mockImplementation(({ messages }) =>
      createUIMessageStream({
        execute: async ({ writer }) => {
          given.push(messages.map(said));
          if (given.length === 1) await held;
          const text = `Re: ${said(messages.at(-1)!)}`;
          writer.write({ type: "start", messageId: randomUUID() });
          writer.write({ type: "text-start", id: "t" });
          writer.write({ type: "text-delta", id: "t", delta: text });
          writer.write({ type: "text-end", id: "t" });
          writer.write({ type: "finish" });
        },
      }),
    );
    // Until the chat's latest turn is its `n`th message's, started.
    const started = (n: number) =>
      waitFor(
        async () => {
          const [stored, turn] = await Promise.all([chats.load(other), testApp.client.turn(other)]);
          return stored.length === n && turn?.runId === `chat:${other}:${stored[n - 1]!.id}`;
        },
        Boolean,
        30_000,
      );
    // Two and Three are sent while One's turn is open, before Two's turn starts.
    const sent = [send(other, [], "One")];
    await waitFor(
      () => given.length,
      (n) => n === 1,
      30_000,
    );
    sent.push(send(other, [], "Two"));
    await started(2);
    sent.push(send(other, [], "Three"));
    await started(3);
    letGo();
    await Promise.all(sent);
    await waitFor(
      async () => (await testApp.client.turn(other))?.status,
      (status) => status === "finished",
      30_000,
    );

    expect(given).toEqual([["One"], ["One", "Re: One", "Two"], ["One", "Re: One", "Two", "Re: Two", "Three"]]);
    expect(((await chats.load(other)) as ChatMessage[]).map(said)).toEqual([
      "One",
      "Re: One",
      "Two",
      "Re: Two",
      "Three",
      "Re: Three",
    ]);
  }, 300_000);

  it("takes an app only from a public repository: the Apps page's prompt and the source's refusal", async () => {
    const other = `apps-${RUN}`;
    const reply = await send(other, [], takeAppPrompt("file:///srv/crm"));
    expect(toolParts(reply).map((part) => [getToolName(part), part.state])).toEqual([["take_app", "output-error"]]);
    // The model reads why (the person's step says only that it failed), and answers.
    expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toMatch(
      /git fetch from file:\/\/\/srv\/crm failed: .*transport 'file' not allowed/,
    );
    expect(reply!.parts.at(-1)).toMatchObject({ type: "text", text: "That source is not a public repository." });
    expect(systems.at(-1)).toContain("take_app takes an app into your draft");
    // Its draft holds nothing.
    expect(git("log", "--format=%s", `draft/${other}`)).toBe("First");
  }, 300_000);

  it("lets the agent speak first: its cue kept but never the person's, the company at a glance in its prompt, its asks as a card", async () => {
    const other = `intro-${RUN}`;
    const reply = await speak(other);
    expect(reply!.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "Hi ada, I make the changes to chat-test. It has two workflows.\n\nAsk me anything.",
    ]);
    expect(reply!.parts.at(-1)).toEqual({
      type: "data-suggestions",
      id: "suggestions",
      data: { asks: ["Add a laptop step to offboarding", "Who can approve a refund?"] },
    });
    expect(systems.at(-1)).toMatch(
      /The company at a glance: its workflows: none; its connectors: crm, mock; its people: ada, lead; its groups: none\./,
    );
    expect(systems.at(-1)).toContain('end your reply with a line that says only "Suggested asks:"');
    expect(systems.at(-1)).toContain("Otherwise suggest none.");

    const { chats } = testApp.client;
    expect(await chats.get(other)).toMatchObject({ person: "ada", engine: "loop", title: "Getting started" });
    await waitFor(async () => (await chats.load(other)).length === 2);
    const [intro, stored] = (await chats.load(other)) as ChatMessage[];
    // The cue, as the server wrote it: what the model was asked, never the browser's text.
    expect(intro).toMatchObject({ role: "user", parts: [{ type: "text", text: INTRO }] });
    expect(isIntro(intro!)).toBe(true);
    expect(stored!.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "Hi ada, I make the changes to chat-test. It has two workflows.\n\nAsk me anything.",
    ]);

    // Once the person has written, the agent does not speak first again.
    await send(other, (await chats.load(other)) as ChatMessage[], "Never mind");
    const again = await post({ id: other, message: cue(), start: true }, { [ACTOR_HEADER]: "ada" });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({
      error: "The agent speaks first only in a chat you have not written in",
    });
  }, 300_000);

  it("refuses another person's chat, a message that is not one or that the chat has, and a request that is not same-origin", async () => {
    const someone = await post({ id, message: userMessage("Hi") }, { [ACTOR_HEADER]: "lead" });
    expect(someone.status).toBe(404);
    const malformed = await post({ id: `other-${RUN}`, message: { role: "user" } }, { [ACTOR_HEADER]: "ada" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_input" });
    // A message the chat has already, by its id: refused, the chat as it was.
    const stored = await testApp.client.chats.load(id);
    const again = await post(
      { id, message: { ...stored[0], parts: [{ type: "text", text: "Hi" }] } },
      { [ACTOR_HEADER]: "ada" },
    );
    expect(again.status).toBe(400);
    // A person's message is text: no file to fetch, no tool's result made up.
    const file = { type: "file", mediaType: "image/png", url: "http://169.254.169.254/latest" };
    const fetching = await post({ id, message: { ...userMessage("Look"), parts: [file] } }, { [ACTOR_HEADER]: "ada" });
    expect(fetching.status).toBe(400);
    expect(await testApp.client.chats.load(id)).toEqual(stored);
    const nobody = await post({ id: `other-${RUN}`, message: userMessage("Hi") });
    expect(nobody.status).toBe(400);
    const elsewhere = await post(
      { id, message: userMessage("Hi") },
      { [ACTOR_HEADER]: "ada", origin: "https://evil.test" },
    );
    expect(elsewhere.status).toBe(403);
    expect(await testApp.client.chats.get(`other-${RUN}`)).toBeUndefined();
  });
});

/** The chat column of `path` as the server renders it for `actor`. */
async function chatColumn(url: string, path = "/workflows", actor = "ada") {
  const res = await fetch(new URL(path, url), { headers: { [ACTOR_HEADER]: actor } });
  expect(res.status).toBe(200);
  const html = (await res.text()).replaceAll("<!-- -->", "");
  return html.match(/<aside id="chat" aria-label="Chat"[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? "";
}

describe("the composer and a model", () => {
  it("has no note and Send waiting for a message once a connector gives a model", async () => {
    const column = await chatColumn(app!.url);
    expect(column).toContain('aria-label="Message the agent"');
    expect(column).not.toContain("Connect a model");
    expect(column).toMatch(/<button(?![^>]*aria-describedby)[^>]*aria-label="Send"/);
  });

  describe("on Anthropic's connector, without its key", () => {
    // A fresh company: the template's Anthropic connector, its key not set yet, on a database of its own.
    const config = { workflows: [], connectors: [anthropic], root, databaseUrl: testDatabaseUrl("chat-no-model") };
    let bare: App | undefined;
    let client: SanomaClient | undefined;
    beforeAll(async () => {
      client = await SanomaClient.connect(config);
      await client.clearCredential("ANTHROPIC_API_KEY", { by: "ada" });
      bare = await startApp(config, { port: 0 });
    });
    afterAll(async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", undefined);
      await bare?.close();
      await client?.close();
    });

    it("shows the ways to connect the agent, its key on the connector page, with Send off; and refuses a turn, or the agent speaking first, before the chat opens", async () => {
      const column = await chatColumn(bare!.url);
      expect(column).toContain(">Connect your agent<");
      expect(column).toMatch(/<a[^>]*href="\/connectors\/anthropic"[^>]*>Add key<\/a>/);
      expect(column).toMatch(/<div id="[^"]+"><p[^>]*>Connect your agent above to start\.<\/p>/);
      const note = /<div id="([^"]+)"><p[^>]*>Connect your agent above/.exec(column)![1]!;
      expect(column).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-label="Send" aria-describedby="${note}"`));

      const chatId = `bare-${RUN}`;
      const res = await post({ id: chatId, message: userMessage("Hi") }, { [ACTOR_HEADER]: "ada" }, bare!.url);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Connect a model to start: anthropic is not configured [connector:anthropic]",
      });
      const intro = await post({ id: chatId, message: cue(), start: true }, { [ACTOR_HEADER]: "ada" }, bare!.url);
      expect(intro.status).toBe(409);
      expect(await client!.chats.get(chatId)).toBeUndefined();
    });

    it("drops the note once the key is set", async () => {
      // Made up, and never sent: the page only asks whether it is set.
      await client!.setCredential("ANTHROPIC_API_KEY", "sk-ant-not-a-key", { by: "ada" });
      const column = await chatColumn(bare!.url);
      expect(column).not.toContain("Connect a model");
      expect(column).not.toContain("Connect your agent");
      expect(column).toMatch(/<button(?![^>]*aria-describedby)[^>]*aria-label="Send"/);
    });

    it("writes the person's message to the chat before its turn's run starts, so a turn no worker runs keeps it", async () => {
      // No worker here: the turn's run waits in its queue, and the reply's stream with it, which the browser leaves.
      const chatId = `kept-${RUN}`;
      const message = userMessage("Hi");
      await fetch(new URL("/api/chat", bare!.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(bare!.url).origin, [ACTOR_HEADER]: "ada" },
        body: JSON.stringify({ id: chatId, message }),
        signal: AbortSignal.timeout(2_000),
      })
        .then((res) => res.text())
        .catch(() => undefined);
      expect(await client!.chats.load(chatId)).toEqual([message]);
      expect(await client!.turn(chatId)).toMatchObject({ runId: `chat:${chatId}:${message.id}`, status: "queued" });
    });
  });
});

/** The text and the asks of a reply streamed as `deltas`, through `suggestedAsks`. */
async function through(deltas: string[]) {
  const chunks = suggestedAsks(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "text-start", id: "t" });
        for (const delta of deltas) controller.enqueue({ type: "text-delta", id: "t", delta });
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }),
  );
  const texts: string[] = [];
  let asks: string[] | undefined;
  for await (const chunk of chunks) {
    if (chunk.type === "text-delta") texts.push(chunk.delta);
    if (chunk.type === "data-suggestions") asks = (chunk.data as { asks: string[] }).asks;
  }
  return { text: texts.join(""), asks };
}

describe("suggestedAsks", () => {
  it("never shows the asks' line or what follows it, however it streams, and keeps the text before it as it comes", async () => {
    const text =
      'Done. Next:\n\nSuggested asks:\n- Remind clients the day before\n1. Let Sam approve refunds\n* "Add a teammate"';
    for (const size of [1, 3, 7, text.length]) {
      const deltas = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      expect(await through(deltas), `${size}`).toEqual({
        text: "Done. Next:",
        asks: ["Remind clients the day before", "Let Sam approve refunds", "Add a teammate"],
      });
    }
  });

  it("lets a line that only starts like the asks' through, and suggests nothing without them", async () => {
    expect(await through(["Su", "re, I can.\n", "Sug", "ar is sweet."])).toEqual({
      text: "Sure, I can.\nSugar is sweet.",
      asks: undefined,
    });
    expect(await through(["One ", "two  \n\n"])).toEqual({ text: "One two", asks: undefined });
    // Mid-line, however the deltas fall, it is the text's own words.
    expect(await through(["Here are the", " suggested asks: below."])).toEqual({
      text: "Here are the suggested asks: below.",
      asks: undefined,
    });
  });

  it("shows what the reply says after its asks once the text ends", async () => {
    expect(await through(["Done.\n\nSuggested asks:\n- A\n\n- B\n\nRestart the worker", " to pick it up."])).toEqual({
      text: "Done.\n\nRestart the worker to pick it up.",
      asks: ["A", "B"],
    });
  });
});

describe("allowedPaths", () => {
  it("allows a path inside the worktree, and refuses one outside it, under .git or node_modules, or through a symlink out, on this machine and in a box", async () => {
    const boxes = mkdtempSync(join(tmpdir(), "sanoma-allowed-"));
    // The worktree is a box's home: the box checks the same paths on its own files.
    const box = await localBackend(boxes).open({ name: "tree" });
    const tree = join(boxes, "tree");
    try {
      mkdirSync(join(tree, "workflows"));
      execFileSync("ln", ["-s", tmpdir(), join(tree, "out")]);
      execFileSync("ln", ["-s", "workflows", join(tree, "in")]);
      const at = realpathSync(tree);
      const refused = [
        "../x",
        "/etc/passwd",
        "out/x",
        ".git/config",
        ".GIT/config",
        "Node_Modules/x/index.js",
        "node_modules/x/index.js",
        "workflows/../../x",
      ];
      for (const real of [here, realIn(box)]) {
        expect(
          await allowedPaths(tree, [".", "workflows/new.ts", "new/deep/file.ts", "in/x.ts", ...refused], real),
        ).toEqual([
          at,
          join(at, "workflows/new.ts"),
          join(at, "new/deep/file.ts"),
          join(at, "workflows/x.ts"),
          ...refused.map(() => undefined),
        ]);
      }
    } finally {
      rmSync(boxes, { recursive: true, force: true });
    }
  });
});
