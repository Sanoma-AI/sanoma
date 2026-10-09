import { fileURLToPath } from "node:url";
import { type Driver, DriverError, errorCode } from "@sanoma/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeLike, type ReplayCall, replayBridge } from "../src/bridge.ts";
import { githubDriver } from "../src/driver.ts";
import { fakeGithub, loadReplies } from "../src/fake.ts";
import { github } from "../src/index.ts";

const replies = fileURLToPath(new URL("../testdata/replies/", import.meta.url));

let seq = 0;
/** Calls one of a driver's operations the way the runtime does. */
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, { idempotencyKey: `run:${++seq}`, runId: "run", opId: `github.${op}`, attempt: 1 });

/** The bridge's error, as `@sanoma/bridge` throws it. */
const bridgeError = (code: string, summary: string) =>
  Object.assign(new Error(summary), { name: "BridgeError", code, diagnostics: [{ summary }] });

describe("githubDriver", () => {
  let calls: ReplayCall[];
  let bridge: BridgeLike;
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghx_test");
    calls = [];
    bridge = replayBridge(loadReplies(replies), calls);
  });

  it("imports, then reads what the import returned, when given no state", async () => {
    const driver = githubDriver({ bridge, owner: "Sanoma-AI" });
    const read = await call(driver, "repository.read", { id: "sanoma" });
    expect(calls).toEqual([
      { method: "configure" },
      { method: "import", typeName: "github_repository", id: "sanoma" },
      { method: "read", typeName: "github_repository", id: "sanoma" },
    ]);
    expect(read).toMatchObject({ id: "sanoma", gone: false, handle: expect.stringMatching(/^1:./) });
    expect(github.repository.read.output.parse(read).state).toMatchObject({ name: "sanoma", has_issues: true });
  });

  it("configures the provider once, and reads a state it was given without importing", async () => {
    const driver = githubDriver({ bridge });
    const imported = await call(driver, "repository.import", { id: "provider-bridge" });
    expect(github.repository.import.output.parse(imported).state).toMatchObject({ name: "provider-bridge" });
    await call(driver, "repository.read", imported);
    expect(calls.map((c) => c.method)).toEqual(["configure", "import", "read"]);
  });

  it("configures the provider with the owner and the token, read on every call", async () => {
    const configure = vi.spyOn(bridge, "configure");
    const close = vi.spyOn(bridge, "close");
    const driver = githubDriver({ bridge, owner: "Sanoma-AI" });
    await call(driver, "repository.import", { id: "sanoma" });
    expect(configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "integrations/github", version: "6.13.0" }),
      JSON.stringify({ owner: "Sanoma-AI", token: "ghx_test" }),
    );
    // A new token: the bridge refuses another config until the provider is closed.
    vi.stubEnv("GITHUB_TOKEN", "ghx_other");
    await call(driver, "repository.import", { id: "sanoma" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it("fails, not retryable, without GITHUB_TOKEN, and calls nothing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const err = await call(githubDriver({ bridge }), "repository.read", { id: "sanoma" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ message: "github: GITHUB_TOKEN is not set", retryable: false });
    expect(calls).toEqual([]);
  });

  it("fails, not retryable, with the provider's diagnostic when GitHub has no such object", async () => {
    const err = await call(githubDriver({ bridge }), "branch_protection.read", { id: "provider-bridge:main" }).catch(
      (e: unknown) => e,
    );
    expect(errorCode(err)).toBe("driver_failed");
    expect(err).toMatchObject({
      message:
        "github: branch_protection.read failed (failed_precondition): could not find a branch protection rule with the pattern 'main'",
      retryable: false,
      vendorCode: "failed_precondition",
    });
  });

  it("is retryable when the provider has exited, and configures it again", async () => {
    const driver = githubDriver({ bridge });
    await call(driver, "repository.import", { id: "sanoma" });
    vi.spyOn(bridge, "import").mockRejectedValueOnce(bridgeError("unavailable", "provider exited"));
    const err = await call(driver, "repository.import", { id: "sanoma" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, vendorCode: "unavailable" });
    await call(driver, "repository.import", { id: "sanoma" });
    expect(calls.filter((c) => c.method === "configure")).toHaveLength(2);
  });

  it("says a repository that no longer exists is gone", async () => {
    const state = loadReplies(replies);
    const driver = githubDriver({ bridge: replayBridge(state) });
    const imported = await call(driver, "repository.import", { id: "sanoma" });
    delete state.objects["github_repository/sanoma"];
    expect(await call(driver, "repository.read", imported)).toEqual({ id: "sanoma", gone: true });
  });
});

describe("fakeGithub", () => {
  it("answers with the recorded repositories through the driver, with GITHUB_TOKEN unset", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const fake = fakeGithub();
    const read = await call(fake.driver, "repository.read", { id: "provider-bridge" });
    expect(read).toMatchObject({ gone: false, state: { name: "provider-bridge", delete_branch_on_merge: false } });
    expect(fake.calls.map((c) => c.op)).toEqual(["github.repository.read"]);
  });

  it("returns a field a test overrides, as if someone changed it at GitHub", async () => {
    const fake = fakeGithub();
    const before = await call(fake.driver, "repository.import", { id: "sanoma" });
    fake.override("repository", "sanoma", { delete_branch_on_merge: true });
    const after = await call(fake.driver, "repository.read", before);
    expect(after.state).toEqual({ ...before.state, delete_branch_on_merge: true });
  });

  it("says a removed object is gone", async () => {
    const fake = fakeGithub();
    const imported = await call(fake.driver, "repository.import", { id: "sanoma" });
    fake.remove("repository", "sanoma");
    expect(await call(fake.driver, "repository.read", imported)).toEqual({ id: "sanoma", gone: true });
    expect(() => fake.override("repository", "sanoma", {})).toThrow("fakeGithub: no recorded github_repository/sanoma");
  });
});
