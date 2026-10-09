import { BridgeError } from "@sanoma/bridge";
import { type BridgeCall, fixturesDir, loadReplies, stateBridge } from "@sanoma/bridge/fake";
import { type Driver, DriverError, errorCode } from "@sanoma/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubDriver } from "../src/driver.ts";
import { fakeGithub } from "../src/fake.ts";
import { github } from "../src/index.ts";
import { provider } from "../src/resources.gen.ts";

let seq = 0;
/** Calls one of a driver's operations the way the runtime does. */
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, { idempotencyKey: `run:${++seq}`, runId: "run", opId: `github.${op}`, attempt: 1 });

describe("githubDriver", () => {
  let bridge: ReturnType<typeof stateBridge>;
  let state: ReturnType<typeof loadReplies>;
  /** The calls the bridge got: method, type and id. */
  const calls = () => bridge.calls.map(({ method, typeName, id }: BridgeCall) => [method, typeName, id]);
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghx_test");
    state = loadReplies(fixturesDir, provider);
    bridge = stateBridge(state);
  });

  it("imports when given no state: the import reads the object too", async () => {
    const read = await call(githubDriver({ bridge, owner: "Sanoma-AI" }), "repository.read", { id: "sanoma" });
    expect(calls()).toEqual([
      ["configure", undefined, undefined],
      ["import", "github_repository", "sanoma"],
    ]);
    expect(read).toMatchObject({ id: "sanoma", gone: false, handle: expect.stringMatching(/^1:./) });
    expect(github.repository.read.output.parse(read).state).toMatchObject({ name: "sanoma", has_issues: true });
  });

  it("configures the provider once, and reads a state it was given without importing", async () => {
    const driver = githubDriver({ bridge });
    const imported = await call(driver, "repository.import", { id: "provider-bridge" });
    expect(github.repository.import.output.parse(imported).state).toMatchObject({ name: "provider-bridge" });
    await call(driver, "repository.read", imported);
    expect(calls().map(([method]) => method)).toEqual(["configure", "import", "read"]);
  });

  it("imports a state it cannot read back, one without an id", async () => {
    const driver = githubDriver({ bridge });
    const imported = await call(driver, "repository.import", { id: "sanoma" });
    const read = await call(driver, "repository.read", { ...imported, state: { ...imported.state, id: null } });
    expect(read).toMatchObject({ id: "sanoma", gone: false, state: { id: "sanoma" } });
    expect(calls().map(([method]) => method)).toEqual(["configure", "import", "import"]);
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
    // A new token: the bridge refuses another config until the provider is closed. Two calls at
    // once configure once.
    vi.stubEnv("GITHUB_TOKEN", "ghx_other");
    await Promise.all([
      call(driver, "repository.import", { id: "sanoma" }),
      call(driver, "repository.import", { id: "provider-bridge" }),
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it("fails, not retryable, without GITHUB_TOKEN, and calls nothing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const err = await call(githubDriver({ bridge }), "repository.read", { id: "sanoma" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ message: "github: GITHUB_TOKEN is not set", retryable: false });
    expect(calls()).toEqual([]);
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
    vi.spyOn(bridge, "import").mockRejectedValueOnce(new BridgeError("unavailable", "provider exited"));
    const err = await call(driver, "repository.import", { id: "sanoma" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, vendorCode: "unavailable" });
    await call(driver, "repository.import", { id: "sanoma" });
    expect(calls().filter(([method]) => method === "configure")).toHaveLength(2);
  });

  it("configures again, and retries, when the bridge has forgotten the provider", async () => {
    const driver = githubDriver({ bridge });
    await call(driver, "repository.import", { id: "sanoma" });
    await bridge.close(); // a restarted bridge
    expect(await call(driver, "repository.import", { id: "sanoma" })).toMatchObject({ id: "sanoma" });
    expect(calls().map(([method]) => method)).toEqual([
      "configure",
      "import",
      "close",
      "import",
      "configure",
      "import",
    ]);
  });

  it("says a repository that no longer exists is gone", async () => {
    const driver = githubDriver({ bridge });
    const imported = await call(driver, "repository.import", { id: "sanoma" });
    delete state.objects["github_repository/sanoma"];
    expect(await call(driver, "repository.read", imported)).toEqual({ id: "sanoma", gone: true });
  });

  it("refuses a handle it did not make", async () => {
    const driver = githubDriver({ bridge });
    const imported = await call(driver, "repository.import", { id: "sanoma" });
    await expect(call(driver, "repository.read", { ...imported, handle: "nope" })).rejects.toMatchObject({
      message: "github: repository.read was given a handle it did not make",
      retryable: false,
    });
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

  it("returns fields a test overrides, in the resource's shape, as if someone changed them at GitHub", async () => {
    const fake = fakeGithub();
    const before = await call(fake.driver, "repository.import", { id: "sanoma" });
    const pages = { build_type: "workflow", cname: null, source: null };
    fake.override("repository", "sanoma", { delete_branch_on_merge: true, pages });
    const after = await call(fake.driver, "repository.read", before);
    expect(after.state).toEqual({
      ...before.state,
      delete_branch_on_merge: true,
      pages: expect.objectContaining(pages),
    });
    expect(() => fake.override("repository", "sanoma", { nope: 1 } as never)).toThrow(
      "fake github: repository has no field nope",
    );
  });

  it("says a removed object is gone", async () => {
    const fake = fakeGithub();
    const imported = await call(fake.driver, "repository.import", { id: "sanoma" });
    fake.remove("repository", "sanoma");
    expect(await call(fake.driver, "repository.read", imported)).toEqual({ id: "sanoma", gone: true });
    expect(() => fake.override("repository", "sanoma", {})).toThrow("fake github: no object github_repository/sanoma");
  });
});
