import { replay } from "sanoma/testing/replay";
import { type CallContext, DriverError, memorySecrets, resolveConfig } from "sanoma/workflows";
import { describe, expect, it, vi } from "vitest";
import { agent37 } from "../src/index.ts";
import { agent37Driver } from "../src/driver.ts";
import { fakeAgent37 } from "../src/fake.ts";
import { wanted } from "../src/connector.ts";
import { agent37 as declare } from "../src/resources.ts";
import { replayOptions } from "./replay.ts";

// Replays test/fixtures, written from Agent37's documentation (no account recorded them yet).

const { play, sent } = replay(replayOptions);

const driver = agent37Driver({ timeoutMs: 200 });
const call = (op: string, input: Record<string, unknown>, ops = driver.ops) =>
  ops[op]!(input, {
    idempotencyKey: "run-1:1",
    runId: "run-1",
    opId: `agent37.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  } satisfies CallContext) as Promise<any>;

describe("agent37.instance", () => {
  it("declares the boxes, and meets the Sandbox contract in a config", () => {
    expect(declare.instance({ size: 4, memory: 16 })).toMatchObject({ vendor: "agent37", type: "instance" });
    expect(() => declare.instance({ size: 2, memory: 8 })).toThrow("Agent37's shapes");
    expect(() => declare.instance({ disk: 13 })).toThrow("the disk is larger than the shape takes");
    expect(() => declare.instance({ id: "x" })).toThrow("leave out id");
    // A size `open` is given over the declared one takes its own memory.
    expect(wanted({ size: 4, memory: 16, disk: 30 }, { size: 2 })).toMatchObject({ size: 2, memory: 4, disk: 10 });
    expect(wanted({ size: 4, memory: 16 }, { size: 4, image: "mine" })).toMatchObject({ memory: 16, image: "mine" });
    expect(() => resolveConfig({ workflows: [], connectors: [agent37] })).not.toThrow();
    expect(declare.instance.sandbox?.outputs({ id: "agent37", healthy: true })).toEqual({
      id: "agent37",
      healthy: true,
    });
  });
});

describe("agent37Driver", () => {
  it("reads a declaration by listing the workspace's instances with the key as the Bearer token", async () => {
    play("list-instances");
    expect(await call("instance.read", { id: "agent37" })).toEqual({
      id: "agent37",
      gone: false,
      state: { id: "agent37", healthy: true },
    });
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/instances"]);
    // Compared, not printed: a failure must not show a live key.
    expect(sent[0]!.headers.get("authorization") === `Bearer ${process.env.AGENT37_API_KEY}`).toBe(true);
  });

  it("creates nothing at Agent37, binding the declaration once the key works", async () => {
    play("list-instances");
    expect(await call("instance.create", { desired: { size: 2 } })).toEqual({
      id: "agent37",
      state: { id: "agent37", healthy: true },
    });
    expect(await call("instance.delete", { id: "agent37" })).toEqual({ id: "agent37", gone: true });
  });

  it("plans a create, and nothing once bound", async () => {
    expect(await call("instance.plan", { desired: { size: 2 } })).toEqual({
      action: "create",
      planned: { size: 2, id: null, healthy: null },
      unknown: ["id", "healthy"],
      replace: [],
    });
    expect(await call("instance.plan", { id: "agent37", desired: { size: 4 } })).toMatchObject({ action: "none" });
    expect(await call("instance.plan", { id: "agent37" })).toMatchObject({ action: "delete" });
  });

  it("fails as Agent37 refuses the key, not to be retried", async () => {
    play("invalid-api-key");
    const failed = await call("instance.read", { id: "agent37" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DriverError);
    expect(failed).toMatchObject({ status: 401, vendorCode: "invalid_api_key", retryable: false });
  });

  it("retries an answer Agent37 says to try again, and its edge's flat errors", async () => {
    play("try-again", [
      { method: "GET", path: "/v1/instances", status: 409, body: { error: { code: "try_again", message: "busy" } } },
    ]);
    expect(await call("instance.read", { id: "agent37" }).catch((e: unknown) => e)).toMatchObject({
      vendorCode: "try_again",
      retryable: true,
    });
    play("edge", [{ method: "GET", path: "/v1/instances", status: 502, body: { error: "upstream_unreachable" } }]);
    expect(await call("instance.read", { id: "agent37" }).catch((e: unknown) => e)).toMatchObject({
      status: 502,
      vendorCode: "upstream_unreachable",
      retryable: true,
    });
  });

  it("refuses to call without its key", async () => {
    vi.stubEnv("AGENT37_API_KEY", "");
    await expect(call("instance.read", { id: "agent37" })).rejects.toThrow("AGENT37_API_KEY is not set");
  });
});

describe("fakeAgent37", () => {
  it("answers as for a key that works", async () => {
    const fake = fakeAgent37();
    expect(await call("instance.read", { id: "agent37" }, fake.driver.ops)).toMatchObject({ gone: false });
  });
});
