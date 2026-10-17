import { fixturesDir } from "@sanoma-ai/bridge/fake";
import { type Driver, memorySecrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { changeReplay } from "../../../packages/bridge/test/change-replay.ts";
import { githubTf } from "../src/connector.ts";
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

// Synthetic until recorded in the test org (`bridge-record --change`): `@sanoma-ai/bridge`'s
// testdata/replies/integrations_github_6.13.0/github_repository/sanoma-apply-test*.
describe("github.repository's change operations", () => {
  let bridge: ReturnType<typeof changeReplay>;
  let driver: Driver;
  beforeEach(() => {
    bridge = changeReplay(fixturesDir, provider);
    driver = githubTf.driver(bridge, () => ({}));
  });
  const name = "sanoma-apply-test";
  const desired = { name, description: "Sanoma's apply tests: an empty repository", visibility: "private" };

  it("creates an empty repository, bound by its node id, then updates and deletes it", async () => {
    const plan = await call(driver, "repository.plan", { desired });
    expect(plan).toMatchObject({ action: "create", planned: { name, node_id: null }, replace: [] });
    expect(plan.unknown).toContain("node_id");

    const created = await call(driver, "repository.create", { desired });
    expect(created).toMatchObject({
      id: "R_kgDOSynthetic",
      state: { name, private: true },
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
