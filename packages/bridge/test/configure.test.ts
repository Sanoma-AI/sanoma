import { describe, expect, it } from "vitest";
import { BridgeError, ensureConfigured } from "@sanoma-ai/bridge";
import { fixturesDir, loadReplies, stateBridge } from "@sanoma-ai/bridge/fake";

const ref = { source: "integrations/github", version: "6.13.0" };
const config = (token: string) => JSON.stringify({ owner: "Sanoma-AI", token });

/** A state bridge over the recorded GitHub replies, and the methods it was called with. */
function bridge() {
  const b = stateBridge(loadReplies(fixturesDir, ref));
  return Object.assign(b, { methods: () => b.calls.map((c) => c.method) });
}

describe("ensureConfigured", () => {
  it("configures once, then runs each call", async () => {
    const b = bridge();
    await ensureConfigured(b, ref, config("a"), () => b.import(ref, "github_repository", "sanoma"));
    await ensureConfigured(b, ref, config("a"), () => b.import(ref, "github_repository", "sanoma"));
    expect(b.methods()).toEqual(["configure", "import", "import"]);
  });

  it("closes and configures again when the config changes, once for concurrent calls", async () => {
    const b = bridge();
    await ensureConfigured(b, ref, config("a"));
    await Promise.all([ensureConfigured(b, ref, config("b")), ensureConfigured(b, ref, config("b"))]);
    expect(b.methods()).toEqual(["configure", "close", "configure"]);
  });

  it("closes the provider for another config only once the calls under the one it has are done", async () => {
    const b = bridge();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const first = ensureConfigured(b, ref, config("a"), async () => {
      await held;
      return b.import(ref, "github_repository", "sanoma");
    });
    const second = ensureConfigured(b, ref, config("b"), () => b.import(ref, "github_repository", "sanoma"));
    // Both calls under the new config wait for the one under the old, then share one configure.
    const third = ensureConfigured(b, ref, config("b"), () => b.import(ref, "github_repository", "provider-bridge"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.methods()).toEqual(["configure"]);
    finish();
    await Promise.all([first, second, third]);
    expect(b.methods()).toEqual(["configure", "import", "close", "configure", "import", "import"]);
  });

  it("configures again after the provider has gone, rethrowing the error", async () => {
    const b = bridge();
    await ensureConfigured(b, ref, config("a"));
    const gone = new BridgeError("unavailable", "provider exited");
    await expect(ensureConfigured(b, ref, config("a"), () => Promise.reject(gone))).rejects.toBe(gone);
    await ensureConfigured(b, ref, config("a"));
    expect(b.methods()).toEqual(["configure", "configure"]);
  });

  it("configures again and retries once when the bridge has forgotten the provider", async () => {
    const b = bridge();
    await ensureConfigured(b, ref, config("a"));
    await b.close(); // a restarted bridge, or another client
    const read = await ensureConfigured(b, ref, config("a"), () =>
      b.read(ref, "github_repository", JSON.stringify({ id: "sanoma" })),
    );
    expect(read.gone).toBe(false);
    expect(b.methods()).toEqual(["configure", "close", "read", "configure", "read"]);
  });

  it("keeps other errors as they are", async () => {
    const b = bridge();
    const error = await ensureConfigured(b, ref, config("a"), () =>
      b.import(ref, "github_branch_protection", "provider-bridge:main"),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "failed_precondition", message: expect.stringContaining("branch protection") });
    expect(b.methods()).toEqual(["configure", "import"]);
  });
});
