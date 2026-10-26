import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt as ensureAppBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { getToolName, isToolUIPart, readUIMessageStream } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyFixture, ensureBuilt } from "../../sanoma/test/fixture.ts";
import { gitIdentity } from "../../sanoma/test/git.ts";
import { localGitSource } from "../../sanoma/src/source.ts";
import { ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { type ChatMessage, chatTransport, type EngineName, type SignInCard } from "../src/lib/chat.ts";
import { OWN_AGENTS, type OwnAgentName } from "../src/server/agent/acp.ts";

// Needs Postgres (`pnpm db:up`) and the built app. The chat's third engine, end to end: a person's
// own coding agent over ACP, through `POST /api/chat` as the browser's transport reads it. No vendor
// account: each agent's install is planted with a fake ACP agent (fixtures/fake-acp-agent.mjs, on
// the SDK's agent side), which signs in, edits and asks as the vendors' do. OpenCode itself, on its
// free model, only with SANOMA_LIVE=1, since its first start installs it.

const RUN = randomUUID().slice(0, 8);
const fake = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

/** What a fake agent does next: how it signs in, what a prompt does (fake-acp-agent.mjs). */
interface FakeConfig {
  signIn: "terminal" | "url" | "once" | "none";
  mode: "work" | "hello" | "die" | "hang";
}

/** The code the fake's terminal sign-in takes. */
const CODE = `pasted-${RUN}`;

// The config's root: its people, and an agent, which is not a person.
const root = mkdtempSync(join(tmpdir(), "sanoma-acp-"));
writeFileSync(join(root, "package.json"), '{ "name": "acp-test", "private": true }\n');
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
export const bot = sanoma.agent({ id: "bot" });
`,
);

const testApp = useTestApp({ workflows: [], connectors: [], root }, { databaseUrl: testDatabaseUrl("acp") });

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
let app: App | undefined;
const home = () => join(dir, ".sanoma/agent-home");
const install = (agent: OwnAgentName) => join(home(), "acp", agent);
const logOf = (agent: OwnAgentName) => join(install(agent), "fake.log");

/** Plants the fake as `agent`'s install, as installed: its marker, its bin, and its config. */
function plant(agent: OwnAgentName, config: FakeConfig) {
  const at = install(agent);
  mkdirSync(join(at, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(at, "installed.json"), JSON.stringify(OWN_AGENTS[agent].packages));
  configure(agent, config);
  const bin = join(at, "node_modules/.bin", OWN_AGENTS[agent].bin);
  writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(fake)} ${JSON.stringify(join(at, "fake.json"))} "$@"\n`);
  chmodSync(bin, 0o755);
}

const configure = (agent: OwnAgentName, config: FakeConfig) =>
  writeFileSync(join(install(agent), "fake.json"), JSON.stringify({ ...config, code: CODE, log: logOf(agent) }));

/** What the fake `agent` logged, entry by entry. */
const logged = (agent: OwnAgentName): Record<string, unknown>[] =>
  existsSync(logOf(agent))
    ? readFileSync(logOf(agent), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

beforeAll(async () => {
  ensureBuilt();
  ensureAppBuilt(
    fileURLToPath(new URL("..", import.meta.url)),
    ["dist/server/server.js"],
    ["pnpm", "exec", "vite", "build"],
  );
  gitIdentity(vi.stubEnv);
  // Credentials in this process: none may reach a person's own agent.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    vi.stubEnv(name, `made-up-${name}`);
  }
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
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
  plant("opencode", { signIn: "none", mode: "work" });
  plant("copilot", { signIn: "terminal", mode: "hello" });
  plant("pi", { signIn: "once", mode: "hello" });
  plant("codex", { signIn: "url", mode: "hello" });
  app = await startApp(testApp.config, { port: 0, source: localGitSource(dir) });
}, 600_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const headers = (actor: string) => ({ [ACTOR_HEADER]: actor, origin: new URL(app!.url).origin });

/** Opens (or continues) the chat `id` on `engine` with `text`, as the chat column does: the reply's stream. */
const opening = (id: string, engine: EngineName, text: string, actor = "ada") =>
  chatTransport(new URL("/api/chat", app!.url).href, () => headers(actor)).sendMessages({
    trigger: "submit-message",
    chatId: id,
    messageId: undefined,
    messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text }] }],
    abortSignal: undefined,
    body: { engine },
  });

/** The reply to `text` as it ended, each snapshot to `onSnapshot`. */
async function send(id: string, engine: EngineName, text: string, onSnapshot?: (reply: ChatMessage) => void) {
  const stream = await opening(id, engine, text);
  let reply: ChatMessage | undefined;
  for await (const snapshot of readUIMessageStream<ChatMessage>({ stream })) {
    reply = snapshot;
    onSnapshot?.(snapshot);
  }
  return reply;
}

const textOfReply = (reply: ChatMessage | undefined) =>
  (reply?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const cardOf = (reply: ChatMessage | undefined): SignInCard | undefined =>
  reply?.parts.findLast((part) => part.type === "data-signIn")?.data;

/** Pastes `code` on the sign-in card of the chat `chat`, as `actor`. */
const paste = (chat: string, code: string, actor = "ada") =>
  fetch(new URL("/api/sign-in", app!.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(actor) },
    body: JSON.stringify({ chat, code }),
  });

describe("the chat on a person's own agent", () => {
  it("edits the draft as the checkout rule answers, relays the agent's updates, commits and checks the draft, and shows its card", async () => {
    const id = `work-${RUN}`;
    const draftRoot = join(dir, ".sanoma/drafts", id);
    const reply = await send(id, "acp-opencode", "Add a laptop step to offboarding");
    expect(textOfReply(reply)).toBe("Drafted: offboarding now collects the laptop.");

    // The agent's updates as the reply's parts: its thought, and its tool calls by their titles.
    expect(reply!.parts.find((part) => part.type === "reasoning")).toMatchObject({ text: "Reading the workflow." });
    const steps = reply!.parts.filter(isToolUIPart);
    expect(steps.map((step) => [getToolName(step), step.title, step.state])).toEqual([
      ["read", "Read workflows/offboarding.ts", "output-available"],
      ["edit", "Write node_modules/evil.js", "output-error"],
      ["execute", "cat /etc/hosts", "output-error"],
      ["edit", "Edit workflows/offboarding.ts", "output-available"],
    ]);
    expect(steps[0]!.output).toBe('import { defineWorkflow, z } from "sanoma";');
    expect(steps[1]).toMatchObject({
      errorText: expect.stringContaining("is outside your checkout, or under .git or node_modules"),
    });
    expect(steps[2]).toMatchObject({ errorText: expect.stringMatching(/^No shell commands in this chat/) });
    expect(steps[3]!.output).toBe(`Changed ${join(draftRoot, "workflows/offboarding.ts")}`);

    // The checkout rule's answers: only an option offered, never allow_always.
    const log = logged("opencode");
    expect(log.filter((entry) => "asked" in entry)).toEqual([
      { asked: "Write node_modules/evil.js", chosen: "reject_once" },
      { asked: "cat /etc/hosts", chosen: "reject_once" },
      { asked: "Edit workflows/offboarding.ts", chosen: "allow_once" },
      { asked: "Edit always", chosen: "cancelled" },
    ]);
    expect(log.find((entry) => "wroteOutside" in entry)).toMatchObject({ wroteOutside: false });
    expect(existsSync(join(draftRoot, "node_modules/evil.js"))).toBe(false);

    // The agent ran in the draft with the person's own home, signs in and reads files as the client
    // says it can, and none of this process's credentials reached it or its terminal.
    const personal = join(home(), "people/ada");
    const start = log.find((entry) => "start" in entry)!;
    expect(start).toMatchObject({ start: ["acp"], home: personal });
    // The planted bin is a shell script, which adds its own (and macOS's).
    const shell = new Set(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
    expect((start.env as string[]).filter((name) => !shell.has(name))).toEqual([
      "COREPACK_ENABLE_DOWNLOAD_PROMPT",
      "COREPACK_HOME",
      "HOME",
      "LANG",
      "PATH",
    ]);
    expect(String(start.path).split(":")[0]).toBe(join(home(), "acp/shims"));
    expect(log.find((entry) => "initialize" in entry)!.initialize).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      elicitation: { url: {} },
      _meta: { "terminal-auth": true },
    });
    expect(log.find((entry) => "terminal" in entry)).toEqual({
      terminal: `home=${personal} token=none\n${draftRoot}\n`,
      exit: { exitCode: 0, signal: null },
    });
    expect(log.find((entry) => "session" in entry)).toEqual({ session: draftRoot });
    // The rules and who asks, then the message, as one prompt.
    expect(String(log.find((entry) => "prompt" in entry)!.prompt)).toMatch(
      /^You are the operator agent[\s\S]*You act for ada\.[\s\S]*\n\nada: Add a laptop step to offboarding$/,
    );

    // The edit is the draft's commit, checked; the live checkout is as it was.
    expect(reply!.parts.filter((part) => part.type === "data-draft").map((part) => part.data)).toEqual([
      {
        branch: `draft/${id}`,
        files: ["workflows/offboarding.ts"],
        summary: expect.stringContaining("workflows/offboarding.ts"),
        checks: { ok: true, problems: [], warnings: [] },
      },
    ]);
    expect(git("log", "--format=%s", `draft/${id}`)).toBe("OpenCode: Add a laptop step to offboarding\nFirst");
    expect(git("show", `draft/${id}:workflows/offboarding.ts`)).toContain("Collected ${person}'s laptop");
    expect(git("status", "--porcelain")).toBe("");

    // The transcript keeps what the browser saw.
    expect(await testApp.client.chats.get(id)).toMatchObject({ engine: "acp-opencode", draftId: id });
    await waitFor(async () => (await testApp.client.chats.load(id)).length === 2);
    const stored = ((await testApp.client.chats.load(id)) as ChatMessage[])[1]!;
    expect(stored.parts.filter(isToolUIPart).map((step) => step.state)).toEqual(steps.map((step) => step.state));
    expect(textOfReply(stored)).toBe("Drafted: offboarding now collects the laptop.");
  }, 300_000);

  it("ends the turn with the error as reply text when the agent dies", async () => {
    configure("opencode", { signIn: "none", mode: "die" });
    try {
      const reply = await send(`die-${RUN}`, "acp-opencode", "Hi");
      expect(textOfReply(reply)).toBe("OpenCode could not answer: it stopped (exit code 3): the fake agent fell over");
      // The step it was in ends as stopped, so the turn does not look cut short.
      expect(reply?.parts.filter(isToolUIPart)).toEqual([
        expect.objectContaining({
          toolCallId: "cut",
          state: "output-error",
          errorText: "It stopped before it finished",
        }),
      ]);
    } finally {
      configure("opencode", { signIn: "none", mode: "work" });
    }
  }, 60_000);

  it("cancels the turn under way, and kills its agent, when a new message comes", async () => {
    configure("opencode", { signIn: "none", mode: "hang" });
    const id = `hang-${RUN}`;
    try {
      const first = send(id, "acp-opencode", "Wait");
      await waitFor(() =>
        logged("opencode").some((entry) => entry.prompt === "Wait" || String(entry.prompt).endsWith("ada: Wait")),
      );
      configure("opencode", { signIn: "none", mode: "hello" });
      const second = await send(id, "acp-opencode", "Hi");
      expect(textOfReply(second)).toBe("Hello.");
      await first;
      expect(logged("opencode").some((entry) => "cancel" in entry)).toBe(true);
    } finally {
      configure("opencode", { signIn: "none", mode: "work" });
    }
  }, 60_000);

  it("shows a terminal sign-in's link and code, writes the code pasted on the card to it, and says to send again", async () => {
    const id = `copilot-${RUN}`;
    let asked: SignInCard | undefined;
    let pasted: Promise<number[]> | undefined;
    const reply = await send(id, "acp-copilot", "Hi", (snapshot) => {
      const card = cardOf(snapshot);
      if (!card?.asks || pasted) return;
      asked = card;
      // Someone else's paste first, then more than one line, then the person's.
      pasted = (async () => [
        (await paste(id, CODE, "lead")).status,
        (await paste(id, `${CODE}\ny`)).status,
        (await paste(id, CODE)).status,
      ])();
    });
    expect(asked).toMatchObject({ agent: "Copilot", state: "waiting", url: "https://example.test/login/device" });
    expect(asked!.text).toContain("enter code FAKE-0001");
    expect(await pasted).toEqual([404, 400, 204]);
    // The sign-in ran our terminal: Copilot's device flow, as the person's own HOME.
    expect(logged("copilot").find((entry) => "login" in entry)).toEqual({ login: ["login", "--device-code"] });
    expect(existsSync(join(home(), "people/ada/.signed-in-copilot"))).toBe(true);
    // The card says it is done, and keeps neither the link nor the code.
    expect(cardOf(reply)).toEqual({ agent: "Copilot", state: "done" });
    await waitFor(async () => (await testApp.client.chats.load(id)).length === 2);
    expect(JSON.stringify(await testApp.client.chats.load(id))).not.toContain("FAKE-0001");
    // Signed in: the next message is answered.
    expect(textOfReply(await send(id, "acp-copilot", "Hi again"))).toBe("Hello.");
    // A code with no sign-in waiting is refused.
    expect((await paste(id, CODE)).status).toBe(404);
  }, 120_000);

  it("shows the command to run once on this computer for a vendor whose sign-in needs a terminal", async () => {
    const reply = await send(`pi-${RUN}`, "acp-pi", "Hi");
    expect(cardOf(reply)).toEqual({
      agent: "Pi",
      state: "once",
      command: `HOME=${join(home(), "people/ada")} ${join(install("pi"), "node_modules/.bin/pi")}`,
      after: "/login",
    });
    expect(textOfReply(reply)).toBe("");
  }, 60_000);

  it("shows Codex's sign-in as the link and code it sends, done when the person finishes", async () => {
    let shown: SignInCard | undefined;
    const reply = await send(`codex-${RUN}`, "acp-codex", "Hi", (snapshot) => {
      const card = cardOf(snapshot);
      if (!card?.url || shown) return;
      shown = card;
      // The person finishes on the vendor's page.
      writeFileSync(join(install("codex"), "fake.json.finished"), "");
    });
    expect(shown).toEqual({
      agent: "Codex",
      state: "waiting",
      url: "https://example.test/device",
      text: "Sign in and enter this code: FAKE-0002",
    });
    expect(cardOf(reply)).toEqual({ agent: "Codex", state: "done" });
    expect(logged("codex")).toEqual(
      expect.arrayContaining([{ authenticate: "chat-gpt-device-code" }, { elicitation: "accept" }]),
    );
  }, 60_000);

  it("is never reached by an agent, which no login admits (the engine refuses one too)", async () => {
    const response = await post(`bot-${RUN}`, "acp-opencode", "bot");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_admitted" });
    expect(logged("opencode").filter((entry) => String(entry.prompt ?? "").endsWith("bot: Hi"))).toEqual([]);
  });
});

/** Opens the chat `id` on `engine` as `actor`, with fetch: the response as it came. */
const post = (id: string, engine: string, actor = "ada") =>
  fetch(new URL("/api/chat", app!.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(actor) },
    body: JSON.stringify({
      id,
      engine,
      message: { id: randomUUID(), role: "user", parts: [{ type: "text", text: "Hi" }] },
    }),
  });

describe.runIf(process.env.SANOMA_LIVE === "1")("the chat on the vendors' own agents", () => {
  it("installs OpenCode, which runs the A4 request on its free model in the draft, with the draft card", async () => {
    rmSync(install("opencode"), { recursive: true, force: true });
    const id = `opencode-live-${RUN}`;
    const started = Date.now();
    const reply = await send(
      id,
      "acp-opencode",
      "Add a laptop step to offboarding: in workflows/offboarding.ts, add `Collected ${person}'s laptop` to the done list.",
    );
    console.log(`OpenCode: the first turn, its install included, took ${Date.now() - started} ms`);
    expect(reply!.parts.filter((part) => part.type === "data-draft")).toHaveLength(1);
    expect(git("show", `draft/${id}:workflows/offboarding.ts`)).toContain("laptop");
    await waitFor(async () => (await testApp.client.chats.load(id)).length === 2);
  }, 900_000);

  it("installs Copilot, which, signed out, shows its device sign-in in the card: the live check stops there", async () => {
    rmSync(install("copilot"), { recursive: true, force: true });
    const id = `copilot-live-${RUN}`;
    const started = Date.now();
    let shown: SignInCard | undefined;
    const reply = await send(id, "acp-copilot", "Reply with the word ok and do nothing else.", (snapshot) => {
      const card = cardOf(snapshot);
      if (!shown && card?.url) {
        shown = card;
        console.log(`Copilot: the sign-in card's link, its install included, after ${Date.now() - started} ms`);
        // The person gives up: the vendor's sign-in is stopped, never completed. No code leaves this test.
        execFileSync("pkill", ["-f", `${install("copilot")}.*login`]);
      }
    });
    expect(shown).toMatchObject({ agent: "Copilot", state: "waiting", url: "https://github.com/login/device" });
    expect(shown!.text).toMatch(/enter code/);
    expect(cardOf(reply)).toMatchObject({ agent: "Copilot", state: "failed" });
    await waitFor(async () => (await testApp.client.chats.load(id)).length === 2);
  }, 900_000);
});
