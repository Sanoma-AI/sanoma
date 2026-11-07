import { expect, it, vi } from "vitest";
import { BridgeError, withProviderSession } from "@sanoma-ai/bridge";
import { fixturesDir, loadReplies, stateBridge } from "@sanoma-ai/bridge/fake";

const ref = { source: "integrations/github", version: "6.13.0" };
const bridge = () => stateBridge(loadReplies(fixturesDir, ref));

it("keeps concurrent accounts and credential replacements in separate sessions", async () => {
  const b = bridge();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const old = withProviderSession(b, ref, '{"token":"synthetic-old"}', async (session) => {
    entered.resolve();
    await release.promise;
    return b.import(session, "github_repository", "sanoma");
  });
  await entered.promise;
  try {
    await Promise.all(
      ["synthetic-new", "synthetic-sales"].map((token) =>
        withProviderSession(b, ref, JSON.stringify({ token }), (session) =>
          b.import(session, "github_repository", "sanoma"),
        ),
      ),
    );
    const configs = b.calls.filter((c) => c.method === "configure");
    expect(new Set(configs.map((c) => c.ref!.sessionId)).size).toBe(3);
    expect(JSON.stringify(b.calls)).not.toContain("synthetic");
    expect(b.calls.filter((c) => c.method === "close")).toHaveLength(2);
  } finally {
    release.resolve();
    await old;
  }
  expect(b.calls.filter((c) => c.method === "close")).toHaveLength(3);
});

it("closes a failed configuration and never replays a mutation implicitly", async () => {
  const b = bridge(),
    run = vi.fn<() => Promise<never>>(async () => {
      throw new BridgeError("unavailable", "lost reply");
    });
  await expect(withProviderSession(b, ref, "{}", run)).rejects.toMatchObject({ code: "unavailable" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(b.calls.map((c) => c.method)).toEqual(["configure", "close"]);
  const close = vi.spyOn(b, "close");
  vi.spyOn(b, "configure").mockRejectedValueOnce(new Error("failed configure"));
  await expect(withProviderSession(b, ref, "{}", run)).rejects.toThrow("failed configure");
  expect(close).toHaveBeenCalledTimes(1);
});

it("preserves a completed mutation result when session cleanup fails", async () => {
  const b = bridge();
  vi.spyOn(b, "close").mockRejectedValue(new Error("lost cleanup response"));
  expect(await withProviderSession(b, ref, "{}", async () => "created")).toBe("created");
});
