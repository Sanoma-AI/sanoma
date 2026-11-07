import { DriverError } from "@sanoma-ai/workflows";
import { describe, expect, it, vi } from "vitest";
import {
  type Bridge,
  BridgeError,
  defaultBridge,
  withProviderSession,
  lazyBridge,
  type StartBridgeOptions,
} from "@sanoma-ai/bridge";

const ref = { source: "integrations/github", version: "6.13.0" };

/** A bridge whose every call answers at once, and counts. */
function stub(): Bridge {
  return {
    schema: vi.fn<Bridge["schema"]>(async () => ({ schema: {} as never, sha256: "" })),
    configure: vi.fn<Bridge["configure"]>(async () => ({ warnings: [] })),
    import: vi.fn<Bridge["import"]>(async () => ({ resources: [], warnings: [] })),
    read: vi.fn<Bridge["read"]>(async () => ({ gone: true, warnings: [] })),
    plan: vi.fn<Bridge["plan"]>(async () => ({
      action: "none",
      plannedStateJson: "{}",
      unknownPaths: [],
      requiresReplace: [],
      planned: new Uint8Array(),
      plannedPrivate: new Uint8Array(),
      planToken: new Uint8Array(),
      warnings: [],
    })),
    apply: vi.fn<Bridge["apply"]>(async () => ({ errors: [], warnings: [] })),
    close: vi.fn<Bridge["close"]>(async () => undefined),
    stop: vi.fn<Bridge["stop"]>(async () => undefined),
  };
}

/** `start` that answers with a new `stub()` each time, keeping those it made. */
function starter() {
  const bridges: Bridge[] = [];
  const start = vi.fn<(options?: StartBridgeOptions) => Promise<Bridge>>(async () => {
    const b = stub();
    bridges.push(b);
    return b;
  });
  return { start, bridges };
}

describe("lazyBridge", () => {
  it("starts once, on the first call, with the options given, and closes nothing before it has started", async () => {
    const { start, bridges } = starter();
    const lazy = lazyBridge({ start, readyTimeoutMs: 5 });
    await lazy.close();
    expect(start).not.toHaveBeenCalled();
    await Promise.all([lazy.configure(ref, "{}"), lazy.import(ref, "github_repository", "sanoma")]);
    await lazy.read(ref, "github_repository", "{}");
    await lazy.plan(ref, "github_repository", { configJson: "{}" });
    await lazy.apply(ref, "github_repository", { priorStateJson: "{}" });
    await lazy.close(ref);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ readyTimeoutMs: 5 });
    const [b] = bridges;
    expect(b!.configure).toHaveBeenCalledTimes(1);
    expect(b!.import).toHaveBeenCalledTimes(1);
    expect(b!.read).toHaveBeenCalledTimes(1);
    expect(b!.plan).toHaveBeenCalledWith(ref, "github_repository", { configJson: "{}" });
    expect(b!.apply).toHaveBeenCalledWith(ref, "github_repository", { priorStateJson: "{}" });
    expect(b!.close).toHaveBeenCalledWith(ref);
  });

  it("tries a failed start again on the next call, and surfaces the failure as a final DriverError", async () => {
    const { start, bridges } = starter();
    start.mockRejectedValueOnce(new Error("provider-bridge: no binary"));
    const lazy = lazyBridge({ start });
    const err = await lazy.read(ref, "github_repository", "{}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ message: "provider-bridge: no binary", retryable: false });
    expect(await lazy.read(ref, "github_repository", "{}")).toMatchObject({ gone: true });
    expect(start).toHaveBeenCalledTimes(2);
    expect(bridges).toHaveLength(1);
  });

  it("throws a BridgeError from the start as it is", async () => {
    const { start } = starter();
    const refused = new BridgeError("unavailable", "socket refused");
    start.mockRejectedValueOnce(refused);
    await expect(lazyBridge({ start }).configure(ref, "{}")).rejects.toBe(refused);
  });

  it.each(["configure", "import", "read"] as const)(
    "stops a bridge whose %s finds it unavailable, even if stopping fails, and starts another on the next call",
    async (method) => {
      const { start, bridges } = starter();
      const lazy = lazyBridge({ start });
      const call = () =>
        method === "configure"
          ? lazy.configure(ref, "{}")
          : method === "import"
            ? lazy.import(ref, "github_repository", "sanoma")
            : lazy.read(ref, "github_repository", "{}");
      await call();
      const [first] = bridges;
      vi.mocked(first![method]).mockRejectedValueOnce(
        BridgeError.from(Object.assign(new Error("bridge exited"), { code: "ECONNRESET" })),
      );
      vi.mocked(first!.stop).mockRejectedValueOnce(new Error("already gone"));
      await expect(call()).rejects.toMatchObject({ code: "unavailable" });
      expect(first!.stop).toHaveBeenCalledTimes(1);
      await call();
      expect(start).toHaveBeenCalledTimes(2);
      expect(bridges[1]![method]).toHaveBeenCalledTimes(1);
      // Any other failure leaves the bridge as it is.
      vi.mocked(bridges[1]![method]).mockRejectedValueOnce(new BridgeError("invalid_argument", "bad input"));
      await expect(call()).rejects.toMatchObject({ code: "invalid_argument" });
      expect(bridges[1]!.stop).not.toHaveBeenCalled();
      await lazy.import(ref, "github_repository", "sanoma");
      expect(start).toHaveBeenCalledTimes(2);
    },
  );

  it("configures a fresh session on each call, including after a bridge restart", async () => {
    const { start, bridges } = starter();
    const lazy = lazyBridge({ start });
    const run = () =>
      withProviderSession(lazy, ref, "{}", (session) => lazy.import(session, "github_repository", "sanoma"));
    await run();
    await run();
    expect(bridges[0]!.configure).toHaveBeenCalledTimes(2);
    vi.mocked(bridges[0]!.read).mockRejectedValueOnce(
      BridgeError.from(Object.assign(new Error("bridge exited"), { code: "ECONNRESET" })),
    );
    await expect(lazy.read(ref, "github_repository", "{}")).rejects.toMatchObject({ code: "unavailable" });
    await run();
    expect(start).toHaveBeenCalledTimes(2);
    expect(bridges[1]!.configure).toHaveBeenCalledTimes(1);
    await lazy.stop();
    await run();
    expect(bridges[2]!.configure).toHaveBeenCalledTimes(1);
  });

  it("stops the bridge it started, and starts another on the next call", async () => {
    const { start, bridges } = starter();
    const lazy = lazyBridge({ start });
    await lazy.stop();
    await lazy.read(ref, "github_repository", "{}");
    await lazy.stop();
    expect(bridges[0]!.stop).toHaveBeenCalledTimes(1);
    await lazy.close();
    expect(bridges[0]!.close).not.toHaveBeenCalled();
    await lazy.read(ref, "github_repository", "{}");
    expect(start).toHaveBeenCalledTimes(2);
    // A start that fails has nothing to stop.
    start.mockRejectedValueOnce(new Error("no binary"));
    await lazy.stop();
    await lazy.read(ref, "github_repository", "{}").catch(() => undefined);
    await lazy.stop();
  });
});

describe("defaultBridge", () => {
  it("is one lazy bridge for the process", () => {
    const bridge = defaultBridge();
    expect(defaultBridge()).toBe(bridge);
    expect(typeof bridge.stop).toBe("function");
  });
});

it("does not stop other sessions when only one provider fails", async () => {
  const { start, bridges } = starter();
  const lazy = lazyBridge({ start });
  await lazy.configure(ref, "{}");
  const first = bridges[0]!;
  vi.mocked(first.import).mockRejectedValueOnce(new BridgeError("unavailable", "provider exited"));
  await expect(lazy.import(ref, "github_repository", "sanoma")).rejects.toMatchObject({ code: "unavailable" });
  await lazy.read({ ...ref, sessionId: "00000000-0000-0000-0000-000000000002" }, "github_repository", "{}");
  expect(first.stop).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
});
