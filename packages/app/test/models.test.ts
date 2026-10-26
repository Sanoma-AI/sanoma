import { fileURLToPath } from "node:url";
import { anthropic } from "@sanoma-ai/connector-anthropic";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConnector, resolveConfig, type SanomaClient, withSetup } from "@sanoma-ai/workflows";
import { customProvider, generateText, NoSuchProviderError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, startApp } from "../src/index.ts";
import { modelRegistry } from "../src/server/models.ts";
import { secretValues } from "../src/server/secrets.ts";

// The app's models: the registry over the connectors' model halves, on a mock model and on
// Anthropic's with no key (so nothing is sent), and Anthropic's key on its connector page, which
// needs Postgres and the built app, as app.test.ts does.

/** A connector whose model half, `make`, answers "Mocked." from a mock model. */
const mockModel = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text: "Mocked." }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  }),
});
const mockProvider = () => customProvider({ languageModels: { default: mockModel } });
const make = vi.fn<typeof mockProvider>(mockProvider);
const mock = withSetup(defineConnector("mock", {}), { model: make });

const config = { workflows: [], connectors: [anthropic, mock], databaseUrl: testDatabaseUrl("models") };
/** No secret is set: Anthropic's model half finds no key. */
const client = { secrets: async () => new Map() } as unknown as SanomaClient;

describe("modelRegistry", () => {
  // The environment wins over the secrets: a key exported in the shell must not reach Anthropic.
  beforeEach(() => vi.stubEnv("ANTHROPIC_API_KEY", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("resolves `<vendor>/<model-id>` over every connector with a model half, made once per resolved config", async () => {
    const resolved = resolveConfig(config);
    const registry = await modelRegistry({ resolved, client });
    expect(await modelRegistry({ resolved, client })).toBe(registry);
    expect(make).toHaveBeenCalledOnce();

    const { text } = await generateText({ model: registry.languageModel("mock/default"), prompt: "Hi." });
    expect(text).toBe("Mocked.");
    expect(registry.languageModel("anthropic/default").modelId).toBe("claude-opus-5-5");
    expect(registry.languageModel("anthropic/claude-sonnet-5-5").modelId).toBe("claude-sonnet-5-5");
    expect(() => registry.languageModel("openai/gpt")).toThrow(NoSuchProviderError);

    // Another resolution makes its own.
    await modelRegistry({ resolved: resolveConfig(config), client });
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("lists a connector without a key, whose model fails when called, sending nothing", async () => {
    const sent = vi.spyOn(globalThis, "fetch");
    const registry = await modelRegistry({ resolved: resolveConfig(config), client });
    await expect(
      generateText({ model: registry.languageModel("anthropic/default"), prompt: "Hi.", maxRetries: 0 }),
    ).rejects.toThrow("anthropic is not configured: ANTHROPIC_API_KEY");
    expect(sent).not.toHaveBeenCalled();
  });

  it("tries again after a maker throws", async () => {
    const failing = vi.fn<typeof mockProvider>().mockImplementationOnce(() => {
      throw new Error("no models today");
    });
    failing.mockImplementation(mockProvider);
    const resolved = resolveConfig({
      ...config,
      connectors: [withSetup(defineConnector("mock", {}), { model: failing })],
    });
    await expect(modelRegistry({ resolved, client })).rejects.toThrow("no models today");
    expect((await modelRegistry({ resolved, client })).languageModel("mock/default")).toBe(mockModel);
  });
});

describe("secretValues", () => {
  it("takes the environment's value first, and reads the stored ones only for the names it leaves unset", async () => {
    // Made-up names and values: nothing here is a credential.
    vi.stubEnv("SANOMA_TEST_ENV_KEY", "from-env");
    vi.stubEnv("SANOMA_TEST_STORED_KEY", "");
    const stored = vi.fn<SanomaClient["secrets"]>(
      async (names) => new Map(names.map((name) => [name, { value: "stored", source: "stored" }])),
    );
    const secrets = secretValues({ secrets: stored } as unknown as SanomaClient);
    expect(await secrets(["SANOMA_TEST_ENV_KEY", "SANOMA_TEST_STORED_KEY"])).toEqual(
      new Map([
        ["SANOMA_TEST_ENV_KEY", "from-env"],
        ["SANOMA_TEST_STORED_KEY", "stored"],
      ]),
    );
    expect(stored).toHaveBeenCalledExactlyOnceWith(["SANOMA_TEST_STORED_KEY"]);
    await secrets(["SANOMA_TEST_ENV_KEY"]);
    expect(stored).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});

describe("Anthropic's connector page", () => {
  let app: App | undefined;
  beforeAll(async () => {
    ensureBuilt(
      fileURLToPath(new URL("..", import.meta.url)),
      ["dist/server/server.js"],
      ["pnpm", "exec", "vite", "build"],
    );
    // The environment never sets it here, so the page shows it missing, with Set.
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    app = await startApp(
      { workflows: [], connectors: [anthropic], databaseUrl: testDatabaseUrl("models") },
      { port: 0 },
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
  });

  it("shows the connector with its key's field, under Credentials", async () => {
    const res = await fetch(new URL("/connectors/anthropic", app!.url));
    expect(res.status).toBe(200);
    const text = (await res.text()).replaceAll("<!-- -->", "");
    expect(text).toMatch(/>Anthropic</);
    expect(text).toMatch(/>Credentials<\/h2>/);
    expect(text).toMatch(
      /<code>ANTHROPIC_API_KEY<\/code>.*?>missing<.*?an API key, from the API Keys page of the Claude Console.*?>Set<\/button>/,
    );
  });
});
