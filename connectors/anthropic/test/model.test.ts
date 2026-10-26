import { LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_DEFAULT_MODEL, anthropicModel } from "../src/model.ts";

// The model half over a stubbed `fetch`: no request leaves the process, and no key is real.

/** A made-up key: nothing here is a credential. */
const KEY = "sk-ant-made-up-key";

/** What Anthropic's Messages API answers, cut to what the adapter reads. */
const reply = (model: string) =>
  Response.json({
    id: "msg_made_up",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Hello." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });

/** The stubbed `fetch`, answering every request as Anthropic would. */
function stubFetch() {
  const sent = vi.fn<typeof fetch>(async (_url, init) => reply(JSON.parse(String(init?.body)).model));
  vi.stubGlobal("fetch", sent);
  return sent;
}

/** A model half whose secrets hold `stored`, as the app's would. */
const provider = (stored: Map<string, string>) => anthropicModel({ secrets: async () => stored });

afterEach(() => vi.unstubAllGlobals());

describe("anthropicModel", () => {
  it("calls Anthropic's Messages API with the key from secrets, the default model for `default`", async () => {
    const sent = stubFetch();
    const { text } = await generateText({
      model: provider(new Map([["ANTHROPIC_API_KEY", KEY]])).languageModel("default"),
      prompt: "Say hello.",
    });
    expect(text).toBe("Hello.");
    expect(sent).toHaveBeenCalledOnce();
    const [url, init] = sent.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: ANTHROPIC_DEFAULT_MODEL });
  });

  it("passes any other model id to the adapter as it is", async () => {
    const sent = stubFetch();
    const model = provider(new Map([["ANTHROPIC_API_KEY", KEY]])).languageModel("claude-haiku-5-5");
    expect(model.modelId).toBe("claude-haiku-5-5");
    await generateText({ model, prompt: "Say hello." });
    expect(JSON.parse(String(sent.mock.calls[0]![1]?.body))).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("reads the key at each request, so one set later is used, and without one sends nothing", async () => {
    const sent = stubFetch();
    const stored = new Map<string, string>();
    const model = provider(stored).languageModel("default");
    const missing = generateText({ model, prompt: "Say hello.", maxRetries: 0 });
    await expect(missing).rejects.toThrow(LoadAPIKeyError);
    await expect(missing).rejects.toThrow(
      "anthropic is not configured: ANTHROPIC_API_KEY (an API key, from the API Keys page of the Claude Console); set it on the connector page",
    );
    expect(sent).not.toHaveBeenCalled();

    stored.set("ANTHROPIC_API_KEY", KEY);
    await generateText({ model, prompt: "Say hello." });
    expect(new Headers(sent.mock.calls[0]![1]?.headers).get("x-api-key")).toBe(KEY);
  });
});
