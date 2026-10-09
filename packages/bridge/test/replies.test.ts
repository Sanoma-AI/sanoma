import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BridgeError } from "@sanoma/bridge";
import { fixturesDir, loadReplies, stateBridge } from "@sanoma/bridge/fake";

const github = { source: "integrations/github", version: "6.13.0" };
const config = "{}";

describe("loadReplies", () => {
  it("loads each recorded object by type and import id, and each failed import", () => {
    const { objects } = loadReplies(fixturesDir, github);
    expect(Object.keys(objects).toSorted()).toEqual([
      "github_branch_protection/provider-bridge:main",
      "github_repository/provider-bridge",
      "github_repository/sanoma",
    ]);
    expect(objects["github_repository/sanoma"]).toMatchObject({
      typeName: "github_repository",
      state: { id: "sanoma", full_name: "Sanoma-AI/sanoma" },
      schemaVersion: 1,
    });
    expect(objects["github_branch_protection/provider-bridge:main"]).toMatchObject({
      error: { code: "failed_precondition" },
    });
  });

  it("gives a fresh copy each time", () => {
    const one = loadReplies(fixturesDir, github);
    delete one.objects["github_repository/sanoma"];
    expect(loadReplies(fixturesDir, github).objects["github_repository/sanoma"]).toBeDefined();
  });

  describe("a read recorded without its import", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-bridge-replies-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const from = join(fixturesDir, "replies/integrations_github_6.13.0/github_repository/sanoma/read.json");
    cpSync(from, join(dir, "replies/integrations_github_6.13.0/github_repository/sanoma/read.json"));

    it("is keyed by the id in its state", () => {
      expect(Object.keys(loadReplies(dir, github).objects)).toEqual(["github_repository/sanoma"]);
    });
  });

  it("is empty for a release with no replies", () => {
    expect(loadReplies(fixturesDir, { source: "stripe/stripe", version: "0.3.0" })).toEqual({ objects: {} });
  });
});

describe("stateBridge", () => {
  it("refuses a call before configure, and another config until close, as the bridge does", async () => {
    const bridge = stateBridge(loadReplies(fixturesDir, github));
    const before = await bridge.import(github, "github_repository", "sanoma").catch((e: unknown) => e);
    expect(before).toBeInstanceOf(BridgeError);
    expect(before).toMatchObject({ code: "failed_precondition", message: expect.stringContaining("not configured") });
    await bridge.configure(github, config);
    await expect(bridge.configure(github, '{"other":1}')).rejects.toMatchObject({ code: "failed_precondition" });
    await bridge.close(github);
    await bridge.configure(github, '{"other":1}');
  });

  it("imports, reads, replays a failed import, and says a removed object is gone", async () => {
    const state = loadReplies(fixturesDir, github);
    const bridge = stateBridge(state);
    await bridge.configure(github, config);
    const { resources } = await bridge.import(github, "github_repository", "sanoma");
    expect(resources[0]).toMatchObject({ typeName: "github_repository", schemaVersion: 1 });
    const failed = await bridge.import(github, "github_branch_protection", "provider-bridge:main").catch((e) => e);
    expect(failed).toMatchObject({
      code: "failed_precondition",
      diagnostics: [{ severity: "error", summary: expect.stringContaining("branch protection rule") }],
    });
    await expect(bridge.import(github, "github_repository", "nope")).rejects.toMatchObject({ code: "not_found" });

    (state.objects["github_repository/sanoma"] as { state: Record<string, unknown> }).state.has_wiki = false;
    const read = await bridge.read(github, "github_repository", resources[0]!.stateJson);
    expect(JSON.parse(read.resource!.stateJson)).toMatchObject({ id: "sanoma", has_wiki: false });
    delete state.objects["github_repository/sanoma"];
    expect(await bridge.read(github, "github_repository", resources[0]!.stateJson)).toEqual({
      gone: true,
      warnings: [],
    });
    expect(bridge.calls.map((c) => [c.method, c.id])).toEqual([
      ["configure", undefined],
      ["import", "sanoma"],
      ["import", "provider-bridge:main"],
      ["import", "nope"],
      ["read", "sanoma"],
      ["read", "sanoma"],
    ]);
  });
});
