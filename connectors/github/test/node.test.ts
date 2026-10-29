import { type BridgeCall, fixturesDir, loadReplies, stateBridge } from "@sanoma-ai/bridge/fake";
import { replay } from "@sanoma-ai/testing/replay";
import { type Driver, DriverError, memorySecrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubDriver } from "../src/driver.ts";
import { fakeGithub } from "../src/fake.ts";
import { provider } from "../src/resources.gen.ts";

// A binding keeps a repository's or a rule's node id, which the provider cannot import by: the
// driver resolves it with one GraphQL query (replayed here), the fake with none.

const { play, sent } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["GITHUB_TOKEN"],
  env: { GITHUB_TOKEN: "ghx_test" },
  // A node's owner and name are public; the query asks for nothing of the token's user.
  scrub: (exchanges) => exchanges,
});

let seq = 0;
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `github.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  });

describe("githubDriver, given a node id", () => {
  let bridge: ReturnType<typeof stateBridge>;
  const imports = () => bridge.calls.filter((c: BridgeCall) => c.method === "import").map((c) => [c.typeName, c.id]);
  beforeEach(() => {
    bridge = stateBridge(loadReplies(fixturesDir, provider));
  });

  it("imports a repository by the name its node id resolves to, for its owner, with one query", async () => {
    play("node-repository");
    const configure = vi.spyOn(bridge, "configure");
    const imported = await call(githubDriver({ bridge }), "repository.import", { id: "R_kgDOU0BoZg" });
    expect(imported).toMatchObject({
      id: "R_kgDOU0BoZg",
      gone: false,
      state: { owner: "Sanoma-AI", name: "sanoma", node_id: "R_kgDOU0BoZg" },
    });
    expect(configure).toHaveBeenCalledWith(
      expect.anything(),
      JSON.stringify({ owner: "Sanoma-AI", token: "ghx_test" }),
    );
    expect(imports()).toEqual([["github_repository", "sanoma"]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer ghx_test");
    expect(sent[0]!.body).toMatchObject({ variables: { id: "R_kgDOU0BoZg" } });
  });

  it("imports a rule by its repository's name and its pattern", async () => {
    play("node-rule");
    // Recorded: provider-bridge's main is unprotected, so the rule is gone.
    expect(await call(githubDriver({ bridge }), "branch_protection.import", { id: "BPR_kwDOAAAAAA" })).toEqual({
      id: "BPR_kwDOAAAAAA",
      gone: true,
    });
    expect(imports()).toEqual([["github_branch_protection", "provider-bridge:main"]]);
  });

  it("says a node GitHub does not know is gone", async () => {
    play("node-missing");
    expect(await call(githubDriver({ bridge }), "repository.import", { id: "R_kgDOAAAAAA" })).toEqual({
      id: "R_kgDOAAAAAA",
      gone: true,
    });
  });

  it("refuses a node of another owner than the declaration's, and imports nothing", async () => {
    play("node-repository");
    const desired = { owner: "someone-else", name: "sanoma" };
    const err = await call(githubDriver({ bridge }), "repository.update", { id: "R_kgDOU0BoZg", desired }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({
      retryable: false,
      message:
        "github: repository.update names two owners, Sanoma-AI and someone-else: a repository moves owner at GitHub, not here",
    });
    expect(imports()).toEqual([]);
  });

  it("is retryable when GitHub fails, and imports a name without a query", async () => {
    play("unavailable", [{ method: "POST", path: "/graphql", status: 502, body: { message: "Server Error" } }]);
    const driver = githubDriver({ bridge });
    expect(await call(driver, "repository.import", { id: "R_kgDOU0BoZg" }).catch((e) => e)).toMatchObject({
      retryable: true,
      status: 502,
      message: "github: resolving the node R_kgDOU0BoZg: Server Error",
    });
    await call(driver, "repository.import", { id: "Sanoma-AI/sanoma" });
    await call(driver, "repository.import", { id: "Sanoma-AI/R_tools" });
    expect(imports()).toEqual([
      ["github_repository", "sanoma"],
      ["github_repository", "R_tools"],
    ]);
    expect(sent).toHaveLength(1);
  });
});

describe("fakeGithub, given a binding id", () => {
  it("finds the object whose binding id it is, with no query", async () => {
    const fake = fakeGithub();
    expect(await call(fake.driver, "repository.import", { id: "R_kgDOU0BoZg" })).toMatchObject({
      id: "R_kgDOU0BoZg",
      gone: false,
      state: { name: "sanoma" },
    });
    fake.put("branch_protection", "sanoma:main", { id: "BPR_sanoma", repository_id: "R_kgDOU0BoZg", pattern: "main" });
    expect(await call(fake.driver, "branch_protection.import", { id: "BPR_sanoma" })).toMatchObject({
      gone: false,
      state: { pattern: "main" },
    });
    expect(await call(fake.driver, "repository.import", { id: "R_unknown" })).toEqual({ id: "R_unknown", gone: true });
    expect(sent).toHaveLength(0);
  });
});
