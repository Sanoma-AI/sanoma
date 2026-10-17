import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BridgeError } from "@sanoma-ai/bridge";
import { fixturesDir, loadReplies, stateBridge } from "@sanoma-ai/bridge/fake";

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

const types = {
  github_repository: { schemaVersion: 1, fields: { vendorOwned: ["node_id", "pages.url"], immutable: ["name"] } },
};
const desired = (fields: Record<string, unknown>) =>
  JSON.stringify({ id: null, name: "made", description: null, node_id: null, ...fields });
const plan = async (bridge: ReturnType<typeof stateBridge>, prior: string | undefined, configJson?: string) =>
  bridge.plan(github, "github_repository", {
    ...(prior && { priorStateJson: prior }),
    ...(configJson && { configJson }),
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

  describe("plans and applies a change to its objects", () => {
    it("plans a create with the computed attributes unknown, and applies it as a new object", async () => {
      const state = loadReplies(fixturesDir, github);
      const bridge = stateBridge(state, [], types);
      await bridge.configure(github, config);
      const create = await plan(bridge, undefined, desired({ description: "d" }));
      expect(create).toMatchObject({ action: "create", unknownPaths: ["id", "node_id"], requiresReplace: [] });
      const { resource } = await bridge.apply(github, "github_repository", { configJson: desired({}), ...create });
      expect(resource).toMatchObject({ typeName: "github_repository", schemaVersion: 1 });
      expect(JSON.parse(resource!.stateJson)).toEqual({
        id: "github_repository-1",
        name: "made",
        description: "d",
        node_id: null,
      });
      expect((await bridge.import(github, "github_repository", "github_repository-1")).resources).toEqual([resource]);
    });

    it("plans none, an update or a replace against the prior state, applies it, and deletes", async () => {
      const state = loadReplies(fixturesDir, github);
      const bridge = stateBridge(state, [], types);
      await bridge.configure(github, config);
      const { resources } = await bridge.import(github, "github_repository", "sanoma");
      const prior = resources[0]!.stateJson;
      // A null keeps the prior value, as for a computed attribute.
      expect(await plan(bridge, prior, desired({ name: "sanoma" }))).toMatchObject({ action: "none" });
      const update = await plan(bridge, prior, desired({ name: "sanoma", description: "new" }));
      expect(update).toMatchObject({ action: "update", unknownPaths: [], requiresReplace: [] });
      expect(JSON.parse(update.plannedStateJson)).toMatchObject({
        id: "sanoma",
        full_name: "Sanoma-AI/sanoma",
        description: "new",
      });
      const updated = await bridge.apply(github, "github_repository", {
        priorStateJson: prior,
        configJson: "{}",
        ...update,
      });
      expect(updated.resource!.stateJson).toBe(update.plannedStateJson);
      expect(state.objects["github_repository/sanoma"]).toMatchObject({ state: { description: "new" } });

      expect(await plan(bridge, prior, desired({ name: "renamed" }))).toMatchObject({
        action: "replace",
        requiresReplace: ["name"],
        unknownPaths: ["id", "node_id"],
      });
      expect(await plan(bridge, prior)).toMatchObject({
        action: "delete",
        plannedStateJson: "",
        planned: new Uint8Array(),
      });
      expect(await bridge.apply(github, "github_repository", { priorStateJson: prior })).toEqual({
        errors: [],
        warnings: [],
      });
      expect(state.objects["github_repository/sanoma"]).toBeUndefined();
      expect((await bridge.read(github, "github_repository", prior)).gone).toBe(true);
      // An update of an object no longer there fails at the provider.
      const gone = await bridge.apply(github, "github_repository", {
        priorStateJson: prior,
        configJson: "{}",
        ...update,
      });
      expect(gone).toEqual({
        errors: [expect.objectContaining({ summary: 'github_repository "sanoma" no longer exists' })],
        warnings: [],
      });
    });

    it("refuses what the bridge refuses", async () => {
      const bridge = stateBridge(loadReplies(fixturesDir, github));
      await expect(plan(bridge, undefined, "{}")).rejects.toMatchObject({ code: "failed_precondition" });
      await bridge.configure(github, config);
      await expect(plan(bridge, undefined)).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(bridge.apply(github, "github_repository", { configJson: "{}" })).rejects.toMatchObject({
        code: "invalid_argument",
        message: "planned is required with config_json",
      });
    });
  });
});
