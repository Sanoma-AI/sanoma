import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { exaDriver } from "../src/driver.ts";
import { replayOptions } from "./replay.ts";

// Replays test/fixtures; the README says how to run these tests against Exa.

const { server, play, fixture, sent } = replay(replayOptions);

const driver = exaDriver({ timeoutMs: live ? 30_000 : 200 });
const call = (op: string, input: Record<string, unknown>) => {
  const context: CallContext = {
    idempotencyKey: "run-1:1",
    runId: "run-1",
    opId: `exa.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  };
  return driver.ops[op]!(input, context);
};
const search = (input: Record<string, unknown> = { query: "workflow automation" }) => call("web.search", input);

describe("exaDriver", () => {
  it("searches with the key in x-api-key, and returns the pages found", async () => {
    play("search-the-web");
    const input = { query: "workflow automation for small businesses", numResults: 2, contents: { text: true } };
    const { results } = (await search(input)) as { results: { url: string; title: string; text?: string }[] };
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: expect.any(String), title: expect.any(String), text: expect.any(String) });
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /search"]);
    expect(sent[0]!.body).toEqual(input);
    // Compared, not printed: a failure must not show a live key.
    expect(sent[0]!.headers.get("x-api-key") === process.env.EXA_API_KEY).toBe(true);
  });

  it("asks for no contents when the input names none, as the fake returns none", async () => {
    play("search-the-web");
    await search({ query: "workflow automation" });
    expect(sent[0]!.body).toEqual({ query: "workflow automation" });
  });

  it("reads pages by URL, with each URL's status", async () => {
    play("read-a-page");
    const input = { urls: ["https://exa.ai/"], text: true };
    const reply = (await call("web.getContents", input)) as { results: unknown[]; statuses: unknown[] };
    expect(sent[0]).toMatchObject({ method: "POST", path: "/contents", body: input });
    expect(reply.results).toHaveLength(1);
    expect(reply.statuses).toEqual([{ id: "https://exa.ai/", status: "success" }]);
  });

  it("finds the pages like one", async () => {
    play("find-similar-pages");
    const input = { url: "https://exa.ai/", numResults: 2, excludeSourceDomain: true };
    const { results } = (await call("web.findSimilar", input)) as { results: { url: string }[] };
    expect(sent[0]).toMatchObject({ method: "POST", path: "/findSimilar", body: input });
    expect(results.map((r) => new URL(r.url).hostname)).not.toContain("exa.ai");
  });

  it("answers a question, with the pages it cites", async () => {
    play("answer-a-question");
    const reply = (await call("web.answer", { query: "What does Exa do?" })) as {
      answer: string;
      citations: { url: string }[];
    };
    expect(sent[0]).toMatchObject({ method: "POST", path: "/answer", body: { query: "What does Exa do?" } });
    expect(reply.answer).toEqual(expect.any(String));
    expect(reply.citations[0]).toMatchObject({ url: expect.any(String) });
  });

  describe.skipIf(live)("when Exa misbehaves", () => {
    it.each([
      ["invalid-api-key", false],
      ["no-more-credits", false],
      ["rate-limit", true],
      ["overloaded", true],
    ])("a %s reply is retryable: %s", async (name, retryable) => {
      const [reply] = fixture(name) as [Exchange & { body: { error: string } }];
      play(name);
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable,
        status: reply.status,
        message: `exa: web.search failed (${reply.status}): ${reply.body.error}`,
      });
    });

    it("fails for good on a 200 with no body, without retrying a call Exa answered", async () => {
      server.use(http.post("*/search", () => new HttpResponse(null, { status: 200 })));
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "exa: web.search replied with no body",
      });
    });

    it("fails for good on an answer that is not text", async () => {
      play("structured", [{ method: "POST", path: "/answer", status: 200, body: { answer: { a: 1 }, citations: [] } }]);
      await expect(call("web.answer", { query: "q" })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "exa: web.answer replied without an answer in text",
      });
    });

    it("fails for good on a 2xx whose body is not JSON", async () => {
      server.use(
        http.post(
          "*/search",
          () => new Response("<html>ok</html>", { headers: { "Content-Type": "application/json" } }),
        ),
      );
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 200,
        message: expect.stringContaining("exa: web.search failed (200): Expected a JSON response"),
      });
    });

    it("fails retryable when the connection drops", async () => {
      server.use(http.post("*/search", () => HttpResponse.error()));
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        status: undefined,
        message: "exa: web.search got no reply",
      });
    });

    it("fails retryable when Exa does not answer in time", async () => {
      server.use(http.all("*", () => delay("infinite")));
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        status: 408,
        message: "exa: web.search timed out after 200 ms",
      });
    });

    it("fails for good when the request cannot be built", async () => {
      vi.stubEnv("EXA_API_KEY", "exa_key\nwith a newline");
      await expect(search()).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: "exa: web.search could not build its request",
      });
      expect(sent).toEqual([]);
    });
  });

  it("refuses a timeout the SDK cannot take when it is made", () => {
    expect(() => exaDriver({ timeoutMs: 1.5 })).toThrow(RangeError);
  });

  it("names the variable when the API key is missing", async () => {
    vi.stubEnv("EXA_API_KEY", undefined);
    await expect(search()).rejects.toMatchObject({
      name: "DriverError",
      retryable: false,
      message: "exa: EXA_API_KEY is not set",
    });
    expect(sent).toEqual([]);
  });
});
