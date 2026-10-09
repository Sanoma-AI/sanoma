import { readFileSync } from "node:fs";
import { fromTfState } from "@sanoma/bridge/tfschema";
import { describe, expect, it } from "vitest";
import { github } from "../src/index.ts";
import { github as declare } from "../src/resources.ts";
import { TYPES } from "../src/driver.ts";

const replies = new URL("../testdata/replies/integrations_github_6.13.0/", import.meta.url);

/** The state a recorded read returned, as the provider holds it. */
const recorded = (path: string) => {
  const { response } = JSON.parse(readFileSync(new URL(path, replies), "utf8"));
  return JSON.parse(response.resource.stateJson) as Record<string, unknown>;
};

describe("the generated GitHub resource types", () => {
  it.each(["sanoma", "provider-bridge"])("parse the recorded read of the %s repository", (name) => {
    const state = fromTfState(TYPES.repository.shape, recorded(`github_repository/${name}/read.json`));
    const parsed = TYPES.repository.schema.parse(state);
    expect(parsed).toMatchObject({ name, full_name: `Sanoma-AI/${name}`, fork: "false", pages: null });
    // `security_and_analysis` is a list of at most one in the provider's state: one object here.
    expect(parsed.security_and_analysis).toMatchObject({ secret_scanning: { status: "disabled" } });
  });

  it("flag what GitHub owns, and keep computed and optional attributes the user's", () => {
    expect(TYPES.repository.fields.vendorOwned).toEqual(expect.arrayContaining(["html_url", "repo_id", "node_id"]));
    expect(TYPES.repository.fields.vendorOwned).not.toContain("etag");
    expect(TYPES.team_membership.fields.immutable).toEqual(["team_id", "username"]);
  });
});

describe("the github connector", () => {
  it.each([
    ["repository", "name"],
    ["branch_protection", "repository_id:pattern"],
    ["team_membership", "team_id:username"],
  ] as const)("reads and imports %s, effect read, by its %s", (type, identity) => {
    for (const op of [github[type].read, github[type].import]) {
      expect(op).toMatchObject({ vendor: "github", resource: type, effect: "read", idempotent: true });
    }
    expect(github[type].read.id).toBe(`github.${type}.read`);
    expect(declare[type].identity).toBe(identity);
  });

  it("declares resources for data files, named by their import ids", () => {
    expect(declare.repository({ name: "sanoma", delete_branch_on_merge: true })).toMatchObject({
      kind: "resource",
      vendor: "github",
      type: "repository",
      name: "sanoma",
    });
    expect(declare.branch_protection({ repository_id: "sanoma", pattern: "main" }).name).toBe("sanoma:main");
    expect(declare.team_membership({ team_id: "core", username: "octocat" }).name).toBe("core:octocat");
  });

  it("compares a repository's topics in any order, and only declared fields", () => {
    const state = { name: "sanoma", topics: ["b", "a"], etag: 'W/"1"', has_wiki: true };
    expect(declare.repository.normalize(state, { name: "sanoma", topics: ["a", "b"] })).toEqual({
      name: "sanoma",
      topics: ["a", "b"],
    });
  });
});
