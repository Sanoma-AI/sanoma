import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturesDir } from "@sanoma/bridge/fake";
import { fromTfState } from "@sanoma/bridge/tfschema";
import { describe, expect, it } from "vitest";
import { githubTf } from "../src/connector.ts";
import { github } from "../src/index.ts";
import { github as declare } from "../src/resources.ts";

const replies = join(fixturesDir, "replies/integrations_github_6.13.0");
const TYPES = githubTf.types;

/** The state a recorded read returned, as the provider holds it. */
const recorded = (path: string) => {
  const { response } = JSON.parse(readFileSync(join(replies, path), "utf8"));
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

  it("flag what GitHub owns, keep computed and optional attributes the user's, and mark sets", () => {
    expect(TYPES.repository.fields.vendorOwned).toEqual(expect.arrayContaining(["html_url", "repo_id", "node_id"]));
    expect(TYPES.repository.fields.vendorOwned).not.toContain("etag");
    expect(TYPES.team_membership.fields.immutable).toEqual(["team_id", "username"]);
    expect(TYPES.repository.fields.unordered).toEqual(["topics"]);
    expect(TYPES.branch_protection.fields.unordered).toEqual([
      "force_push_bypassers",
      "required_pull_request_reviews.dismissal_restrictions",
      "required_pull_request_reviews.pull_request_bypassers",
      "required_status_checks.contexts",
      "restrict_pushes.push_allowances",
    ]);
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

  it("keeps the resource types beside the connector's vendor", () => {
    expect(Object.keys(declare)).toEqual(["repository", "branch_protection", "team_membership"]);
    expect(declare.repository.vendor).toBe("github");
  });

  it("declares resources for data files, named by their import ids, without what GitHub sets", () => {
    expect(() => declare.repository({ name: "sanoma", html_url: "https://github.com/x" })).toThrow(
      "github.repository: leave out html_url: the vendor sets it",
    );
    expect(declare.repository({ name: "sanoma", delete_branch_on_merge: true })).toMatchObject({
      kind: "resource",
      vendor: "github",
      type: "repository",
      name: "sanoma",
    });
    expect(declare.branch_protection({ repository_id: "sanoma", pattern: "main" }).name).toBe("sanoma:main");
    expect(declare.team_membership({ team_id: "core", username: "octocat" }).name).toBe("core:octocat");
  });

  it("compares a repository's topics, a set, in any order, and only declared fields", () => {
    const state = { name: "sanoma", topics: ["b", "a"], etag: 'W/"1"', has_wiki: true };
    const desired = { name: "sanoma", topics: ["a", "b"] };
    expect(declare.repository.normalize(state, desired)).toEqual({ name: "sanoma", topics: ["a", "b"] });
    expect(declare.repository.normalize(state, desired)).toEqual(declare.repository.normalize(desired, desired));
    // A branch protection rule's status checks are a set too, inside a block.
    const rule = { repository_id: "sanoma", pattern: "main", required_status_checks: [{ contexts: ["b", "a"] }] };
    const declared = { ...rule, required_status_checks: [{ contexts: ["a", "b"] }] };
    expect(declare.branch_protection.normalize(rule, declared)).toEqual(
      declare.branch_protection.normalize(declared, declared),
    );
  });
});
