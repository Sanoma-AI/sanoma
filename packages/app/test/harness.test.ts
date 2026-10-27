import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { ensureBuilt as ensureAppBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { getToolName, isToolUIPart, readUIMessageStream } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyFixture, ensureBuilt } from "../../sanoma/test/fixture.ts";
import { gitIdentity } from "../../sanoma/test/git.ts";
import { localGitSource } from "../../sanoma/src/source.ts";
import { ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { type ChatMessage, chatTransport, type EngineName } from "../src/lib/chat.ts";

// Needs Postgres (`pnpm db:up`) and the built app. The chat's second engine, end to end: an existing
// coding agent through HarnessAgent in our local session, on the Anthropic connector's key. No
// adapter takes an AI SDK model (each takes a model id and its key), so the model is a loopback
// stand-in for Anthropic's Messages API, scripted like chat.test.ts's mock and reached through
// `ANTHROPIC_BASE_URL`, with a key made up here. Pi runs every time; Claude Code only with
// SANOMA_LIVE=1, since its bridge's first start installs it (about 750 MB under the session's home).

const RUN = randomUUID().slice(0, 8);
/** A made-up key: the stand-in checks it is the one the agent sends. */
const KEY = `sk-ant-test-${randomUUID()}`;

/** What the stand-in was sent, request by request. */
interface Sent {
  key: string | undefined;
  tools: string[];
  /** The tool results in the request's last message from the user's side, as text. */
  results: string[];
}
const sent: Sent[] = [];

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
type Message = { role: string; content: string | { type: string; text?: string; content?: unknown }[] };
type Tool = { name: string; input_schema?: { properties?: Record<string, unknown> } };

/** The draft's checkout, where the agents work. */
let draftRoot = "";

/**
 * The script for "Add a laptop step to offboarding", by the step (the assistant's messages since
 * the person's): read the workflow, try a command and a write under node_modules (both refused by
 * the checkout rule), edit the workflow (allowed), then say so.
 */
function stepFor(step: number, tools: Tool[]): Block {
  const tool = (name: string) => tools.find((t) => t.name.toLowerCase() === name)!;
  const keys = (name: string) => Object.keys(tool(name).input_schema?.properties ?? {});
  const key = (name: string, pattern: RegExp) => keys(name).find((k) => pattern.test(k))!;
  const file = join(draftRoot, "workflows/offboarding.ts");
  const use = (name: string, input: Record<string, unknown>): Block => ({
    type: "tool_use",
    id: `toolu_${RUN}_${step}`,
    name: tool(name).name,
    input,
  });
  switch (step) {
    case 0:
      return use("read", { [key("read", /path/i)]: file });
    case 1:
      return use("bash", { command: "pnpm test" });
    case 2:
      return use("write", {
        [key("write", /path/i)]: join(draftRoot, "node_modules/evil.js"),
        [key("write", /content/i)]: "throw 1;\n",
      });
    case 3:
      return use("edit", {
        [key("edit", /path/i)]: file,
        [key("edit", /old/i)]: "`Removed ${person}'s accounts`",
        [key("edit", /new/i)]: "`Removed ${person}'s accounts`, `Collected ${person}'s laptop`",
      });
    default:
      return { type: "text", text: "Drafted: offboarding now collects the laptop. Merge the branch to apply it." };
  }
}

/** The stand-in for Anthropic's Messages API: streams the script's step for each request. */
function standIn(): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) return res.writeHead(404).end("{}");
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        return res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
      }
      const request = JSON.parse(body) as { tools?: Tool[]; messages: Message[]; model: string };
      const blocks = (m: Message) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
      const isResults = (m: Message) => blocks(m).some((b) => b.type === "tool_result");
      const asked = request.messages.findLastIndex((m) => m.role === "user" && !isResults(m));
      const step = request.messages.slice(asked).filter((m) => m.role === "assistant").length;
      // Pi's requests end with an empty system message after the person's.
      const last = request.messages.findLast((m) => m.role === "user")!;
      sent.push({
        key: req.headers["x-api-key"] as string | undefined,
        tools: (request.tools ?? []).map((t) => t.name),
        results: blocks(last)
          .filter((b) => b.type === "tool_result")
          .map((b) => JSON.stringify(b.content)),
      });
      const block = stepFor(step, request.tools ?? []);
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const message = {
        id: `msg_${step}`,
        type: "message",
        role: "assistant",
        model: request.model,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null, stop_sequence: null } });
      if (block.type === "tool_use") {
        event("content_block_start", { index: 0, content_block: { ...block, input: {} } });
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      res.end();
    });
  });
}

// The config's root: its people.
const root = mkdtempSync(join(tmpdir(), "sanoma-harness-"));
writeFileSync(join(root, "package.json"), '{ "name": "harness-test", "private": true }\n');
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
`,
);

const testApp = useTestApp(
  { workflows: [], connectors: [anthropic], root },
  { databaseUrl: testDatabaseUrl("harness") },
);

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let app: App | undefined;
let server: Server | undefined;

beforeAll(async () => {
  ensureBuilt();
  ensureAppBuilt(
    fileURLToPath(new URL("..", import.meta.url)),
    ["dist/server/server.js"],
    ["pnpm", "exec", "vite", "build"],
  );
  gitIdentity(vi.stubEnv);
  server = standIn();
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  vi.stubEnv("ANTHROPIC_API_KEY", KEY);
  vi.stubEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
  dir = realpathSync(copyFixture());
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
  // A person's own agent's sign-in, beside the session's home.
  mkdirSync(join(dir, ".sanoma/agent-home/people/ada"), { recursive: true });
  writeFileSync(join(dir, ".sanoma/agent-home/people/ada/.credentials.json"), "{}");
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  app = await startApp(testApp.config, {
    port: 0,
    source: localGitSource(dir, { databaseUrl: testApp.config.databaseUrl! }),
  });
}, 600_000);

afterAll(async () => {
  await app?.close();
  server?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Opens the chat `id` on `engine` with `text`, as the chat column does: the reply's stream. */
const opening = (id: string, engine: EngineName, text: string) =>
  chatTransport(new URL("/api/chat", app!.url).href, () => ({
    [ACTOR_HEADER]: "ada",
    origin: new URL(app!.url).origin,
  })).sendMessages({
    trigger: "submit-message",
    chatId: id,
    messageId: undefined,
    messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text }] }],
    abortSignal: undefined,
    body: { engine },
  });

/** Opens the chat `id` on `engine` with `text`; the reply as it ended. */
async function send(id: string, engine: EngineName, text: string) {
  const stream = await opening(id, engine, text);
  let reply: ChatMessage | undefined;
  for await (const snapshot of readUIMessageStream<ChatMessage>({ stream })) reply = snapshot;
  return reply;
}

const engines: [EngineName, string, boolean][] = [
  ["pi", "Pi", true],
  ["claude-code", "Claude Code", process.env.SANOMA_LIVE === "1"],
];

describe.each(engines)("the chat on %s", (engine, name, enabled) => {
  it.runIf(enabled)(
    "edits the draft as the checkout rule allows, commits and checks it, and shows the draft card",
    async () => {
      const id = `${engine}-${RUN}`;
      draftRoot = join(dir, ".sanoma/drafts", id);
      sent.length = 0;
      const started = Date.now();
      const reply = await send(id, engine, "Add a laptop step to offboarding");
      console.log(`${name}: the turn took ${Date.now() - started} ms`);
      expect(
        reply!.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).toMatch(/Drafted/);

      // The key reached the model as the auth record set it.
      expect(sent.length).toBeGreaterThanOrEqual(5);
      expect(sent.every((request) => request.key === KEY)).toBe(true);
      // The command and the write under node_modules were refused, with the reason the agent read.
      const results = sent.flatMap((request) => request.results).join("\n");
      expect(results).toMatch(/No shell commands in this chat/);
      expect(results).toMatch(/evil\.js is outside your checkout, or under \.git or node_modules/);
      expect(existsSync(join(draftRoot, "node_modules/evil.js"))).toBe(false);
      expect(toolNames(reply)).toEqual(expect.arrayContaining(["read", "bash", "write", "edit"]));

      // The edit is the draft's commit, checked; the live checkout is as it was.
      const cards = reply!.parts.filter((part) => part.type === "data-draft");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.data).toEqual({
        draft: id,
        branch: `draft/${id}`,
        files: ["workflows/offboarding.ts"],
        summary: expect.stringContaining("workflows/offboarding.ts"),
        checks: { ok: true, problems: [], warnings: [] },
      });
      expect(git("log", "--format=%s", `draft/${id}`)).toBe(`${name}: Add a laptop step to offboarding\nFirst`);
      expect(git("show", `draft/${id}:workflows/offboarding.ts`)).toContain("Collected ${person}'s laptop");
      expect(git("status", "--porcelain")).toBe("");

      // The chat keeps its engine, its draft and its transcript; the session's run files are gone.
      expect(await testApp.client.chats.get(id)).toMatchObject({ engine, draftId: id });
      await waitFor(async () => (await testApp.client.chats.load(id)).length === 2);
      const runs = join(dir, ".sanoma/agent-home/harness/.ai-sdk-harness/.agent-runs");
      expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
      // The session's state is all in its own home, beside people's own agents'.
      expect(readdirSync(join(dir, ".sanoma/agent-home")).toSorted()).toEqual(["harness", "people"]);
      expect(existsSync(join(dir, ".sanoma/agent-home/people/ada/.credentials.json"))).toBe(true);
    },
    engine === "pi" ? 300_000 : 900_000,
  );
});

describe("the chat on a coding agent without its key", () => {
  it("says which key is missing, with its connector's page, as the reply's error", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    try {
      const stream = await opening(`nokey-${RUN}`, "pi", "Hi");
      const chunks: string[] = [];
      for await (const chunk of stream) if (chunk.type === "error") chunks.push(chunk.errorText);
      expect(chunks).toEqual([
        "anthropic is not configured: ANTHROPIC_API_KEY; set it on the connector page [connector:anthropic]",
      ]);
      expect(await testApp.client.chats.get(`nokey-${RUN}`)).toMatchObject({ engine: "pi" });
    } finally {
      vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    }
  });
});

/** The reply's tool parts' names, lower-cased (Claude Code's own are capitalised). */
const toolNames = (reply: ChatMessage | undefined) =>
  (reply?.parts ?? []).filter(isToolUIPart).map((part) => getToolName(part).toLowerCase());
