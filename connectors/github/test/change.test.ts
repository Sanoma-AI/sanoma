import { fixturesDir, loadReplies } from "@sanoma-ai/bridge/fake";
import { type Driver, memorySecrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { changeReplay } from "../../../packages/bridge/test/change-replay.ts";
import { githubTf } from "../src/connector.ts";
import { owned } from "../src/owner.ts";
import { provider } from "../src/resources.gen.ts";

let seq = 0;
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `github.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  });

// Synthetic until recorded in the test org, `sanoma-test` (`bridge-record --change`): `@sanoma-ai/bridge`'s
// testdata/replies/integrations_github_6.13.0/github_repository/sanoma-apply-test*.
describe("github.repository's change operations", () => {
  let bridge: ReturnType<typeof changeReplay>;
  let driver: Driver;
  beforeEach(() => {
    bridge = changeReplay(fixturesDir, provider);
    // The driver's calls, named by owner, over the replies: no token, no GraphQL.
    driver = owned(() => githubTf.driver(bridge, () => ({})));
  });
  const name = "sanoma-apply-test";
  const desired = {
    owner: "sanoma-test",
    name,
    description: "Sanoma's apply tests: an empty repository",
    visibility: "private",
  };

  it("creates an empty repository, bound by its node id, then updates and deletes it", async () => {
    const plan = await call(driver, "repository.plan", { desired });
    expect(plan).toMatchObject({
      action: "create",
      planned: { owner: "sanoma-test", name, node_id: null },
      replace: [],
    });
    expect(plan.unknown).toContain("node_id");

    const created = await call(driver, "repository.create", { desired });
    expect(created).toMatchObject({
      id: "R_kgDOSynthetic",
      state: { owner: "sanoma-test", name, private: true },
      handle: expect.any(String),
    });

    const description = "Sanoma's apply tests: an empty repository, updated";
    const updated = await call(driver, "repository.update", {
      ...created,
      desired: { ...desired, description },
      expect: { action: "update", replace: [] },
    });
    expect(updated).toMatchObject({ id: created.id, state: { name, description } });

    expect(await call(driver, "repository.delete", updated)).toEqual({ id: created.id, gone: true });
    expect(bridge.calls.filter((c) => c.method === "apply")).toHaveLength(3);
  });
});

// Synthetic until recorded in the test org, in the provider's shape (its `id` is
// `<repository>:<key id>`, which the driver gives as `<owner>/<repository>:<key id>`, GitHub reads a key back without its comment, every attribute is
// ForceNew): `@sanoma-ai/bridge`'s testdata/replies/integrations_github_6.13.0/github_repository_deploy_key/.
describe("github.repository_deploy_key's change operations", () => {
  let bridge: ReturnType<typeof changeReplay>;
  let driver: Driver;
  beforeEach(() => {
    bridge = changeReplay(fixturesDir, provider);
    // The driver's calls, named by owner, over the replies: no token, no GraphQL.
    driver = owned(() => githubTf.driver(bridge, () => ({})));
  });
  // The key the replies hold: the recorded object's.
  const recorded = loadReplies(fixturesDir, provider).objects[
    "github_repository_deploy_key/sanoma-apply-test:1000000101"
  ];
  const { key } = (recorded && "state" in recorded ? recorded.state : {}) as { key: string };
  // The repository as a data file names it, by the declared one: `<owner>/<name>`.
  const desired = { repository: "sanoma-test/sanoma-apply-test", title: "Sanoma host", key, read_only: true };

  it("creates a read-only key on a repository, bound by `<owner>/<repository>:<key id>`, and deletes it", async () => {
    const plan = await call(driver, "repository_deploy_key.plan", { desired });
    expect(plan).toMatchObject({
      action: "create",
      planned: { repository: "sanoma-test/sanoma-apply-test", key, read_only: true },
      replace: [],
    });
    expect(plan.unknown).toEqual(["etag", "id"]);

    const created = await call(driver, "repository_deploy_key.create", { desired });
    expect(created).toMatchObject({ id: "sanoma-test/sanoma-apply-test:1000000101", state: desired });
    // The replies answer the provider's config, the repository's name alone, so this is what it was given.
    expect(created.state.id).toBe(created.id);

    expect(await call(driver, "repository_deploy_key.delete", created)).toEqual({ id: created.id, gone: true });
    expect(bridge.calls.filter((c) => c.method === "apply")).toHaveLength(2);
  });
});
