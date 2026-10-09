import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { BridgeError, startBridge } from "@sanoma/bridge";
import { bridgeClient } from "../src/bridge.ts";
import { BridgeService, Diagnostic_Severity, DiagnosticSchema } from "../src/gen/bridge/v1/bridge_pb.ts";

const ref = { source: "example/widget", version: "1.0.0" };

/** A bridge whose every call fails with `error`. */
function failing(error: Error) {
  const transport = createRouterTransport(({ service }) =>
    service(BridgeService, {
      getSchema: () => Promise.reject(error),
      configure: () => Promise.reject(error),
      import: () => Promise.reject(error),
      read: () => Promise.reject(error),
      close: () => Promise.reject(error),
    }),
  );
  return bridgeClient(createClient(BridgeService, transport), async () => {});
}

describe("BridgeError", () => {
  it("carries the Connect code and the provider's diagnostics", async () => {
    const bridge = failing(
      new ConnectError("example/widget 1.0.0: provider exited; configure again", Code.Unavailable, undefined, [
        {
          desc: DiagnosticSchema,
          value: { severity: Diagnostic_Severity.ERROR, summary: "plugin exited", detail: "signal: killed" },
        },
        {
          desc: DiagnosticSchema,
          value: { severity: Diagnostic_Severity.WARNING, summary: "slow", attributePath: "settings.timeout" },
        },
      ]),
    );
    const error = await bridge.read(ref, "widget_thing", "{}").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      name: "BridgeError",
      code: "unavailable",
      message: "example/widget 1.0.0: provider exited; configure again",
      diagnostics: [
        { severity: "error", summary: "plugin exited", detail: "signal: killed", attributePath: "" },
        { severity: "warning", summary: "slow", detail: "", attributePath: "settings.timeout" },
      ],
    });
  });

  it.each([
    [Code.NotFound, "not_found"],
    [Code.FailedPrecondition, "failed_precondition"],
    [Code.InvalidArgument, "invalid_argument"],
    [Code.DeadlineExceeded, "deadline_exceeded"],
  ])("maps code %i to %s", async (code, name) => {
    const error = await failing(new ConnectError("no", code))
      .import(ref, "widget_thing", "x")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: name, diagnostics: [] });
  });

  it("wraps an error that is not a Connect error as unknown", () => {
    const cause = new Error("socket hang up");
    expect(BridgeError.from(cause)).toMatchObject({ code: "unknown", message: "socket hang up", cause });
  });
});

describe("startBridge", () => {
  it("says how to get a binary when it has none", async () => {
    vi.stubEnv("SANOMA_BRIDGE_BIN", "");
    await expect(startBridge()).rejects.toThrow(/SANOMA_BRIDGE_BIN.*pnpm bridge:download/);
  });

  it("reports a bridge that exits before it is ready", async () => {
    await expect(startBridge({ bin: "/usr/bin/false", readyTimeoutMs: 5_000 })).rejects.toThrow(
      /provider-bridge did not start: it exited \(code 1\)/,
    );
  });
});
