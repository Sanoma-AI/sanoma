import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { ensureBuilt as ensureAppBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { defineConnector, defineDriver, isEnded, SanomaClient, withSetup } from "@sanoma-ai/workflows";
import { customProvider, getToolName, isToolUIPart, readUIMessageStream } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { copyFixture, ensureBuilt } from "../../sanoma/test/fixture.ts";
import { gitIdentity } from "../../sanoma/test/git.ts";
import { localGitSource } from "../../sanoma/src/source.ts";
import { ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { takeAppPrompt } from "../src/lib/apps.ts";
import { type ChatMessage, chatTransport } from "../src/lib/chat.ts";
import { allowedPath } from "../src/server/agent/checkout.ts";

// Needs Postgres (`pnpm db:up`) and the built app. The chat's route, end to end, on our loop: a mock
// model (a connector's model half, as models.test.ts attaches one) that answers each request by a
// script, the sanoma package's fixture company as the repository (its own git repository, with an
// offboarding workflow), and a lookup the policy holds for a lead. No fake stream layer: the route's
// stream as the browser's transport reads it.

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
  continue: [{ text: "Acme Ltd is a customer since 2019." }],
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
  ensureAppBuilt(
    fileURLToPath(new URL("..", import.meta.url)),
    ["dist/server/server.js"],
    ["pnpm", "exec", "vite", "build"],
  );
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
 * Sends `text` to the chat `id` after `history`, as useChat does: each snapshot of the reply to
 * `onSnapshot`, and the reply as it ended. A stream cut short ends the reply where it was.
 */
async function send(id: string, history: ChatMessage[], text: string, onSnapshot?: (reply: ChatMessage) => void) {
  const stream = await transport().sendMessages({
    trigger: "submit-message",
    chatId: id,
    messageId: undefined,
    messages: [...history, userMessage(text)],
    abortSignal: undefined,
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

/** A request to the route of the app at `url`, as fetch sends it, from its own origin unless `headers` say otherwise. */
const post = (body: unknown, headers: Record<string, string> = {}, url = app!.url) =>
  fetch(new URL("/api/chat", url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify(body),
  });

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

  it("shows a held lookup as its approval, and after a restart reloads the chat, settles it and continues", async () => {
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

    // The server stops mid-turn; the lead approves; the server starts again.
    await app!.close();
    app = undefined;
    const cut = await turn;
    expect(toolParts(cut)[0]).toMatchObject({ preliminary: true, output: { held: { runId } } });
    await testApp.client.decide(runId!, { decision: "approve", by: { id: "lead" } });
    await waitFor(async () => isEnded((await testApp.client.run(runId!))?.status ?? "running"), Boolean, 30_000);
    await start();

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

    it("says to connect a model, linking to the connector page, with Send off; and refuses a turn before the chat opens", async () => {
      const column = await chatColumn(bare!.url);
      expect(column).toMatch(
        /<div id="[^"]+"><p[^>]*>Connect a model to start: <a[^>]*href="\/connectors\/anthropic"[^>]*>set its key on the Anthropic connector page<\/a>\.<\/p>/,
      );
      const note = /<div id="([^"]+)"><p[^>]*>Connect a model/.exec(column)![1]!;
      expect(column).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-label="Send" aria-describedby="${note}"`));

      const chatId = `bare-${RUN}`;
      const res = await post({ id: chatId, message: userMessage("Hi") }, { [ACTOR_HEADER]: "ada" }, bare!.url);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Connect a model to start: anthropic is not configured [connector:anthropic]",
      });
      expect(await client!.chats.get(chatId)).toBeUndefined();
    });

    it("drops the note once the key is set", async () => {
      // Made up, and never sent: the page only asks whether it is set.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-a-key");
      const column = await chatColumn(bare!.url);
      expect(column).not.toContain("Connect a model");
      expect(column).toMatch(/<button(?![^>]*aria-describedby)[^>]*aria-label="Send"/);
    });
  });
});

describe("allowedPath", () => {
  it("allows a path inside the worktree, and refuses one outside it, under .git or node_modules, or through a symlink out", async () => {
    const tree = mkdtempSync(join(tmpdir(), "sanoma-allowed-"));
    try {
      mkdirSync(join(tree, "workflows"));
      execFileSync("ln", ["-s", tmpdir(), join(tree, "out")]);
      execFileSync("ln", ["-s", "workflows", join(tree, "in")]);
      const real = (await allowedPath(tree, "."))!;
      expect(await allowedPath(tree, "workflows/new.ts")).toBe(join(real, "workflows/new.ts"));
      expect(await allowedPath(tree, "new/deep/file.ts")).toBe(join(real, "new/deep/file.ts"));
      expect(await allowedPath(tree, "in/x.ts")).toBe(join(real, "workflows/x.ts"));
      for (const path of [
        "../x",
        "/etc/passwd",
        "out/x",
        ".git/config",
        ".GIT/config",
        "Node_Modules/x/index.js",
        "node_modules/x/index.js",
        "workflows/../../x",
      ]) {
        expect(await allowedPath(tree, path), path).toBeUndefined();
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
