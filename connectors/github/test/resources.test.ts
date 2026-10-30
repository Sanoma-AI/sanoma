import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturesDir } from "@sanoma-ai/bridge/fake";
import { fromTfState } from "@sanoma-ai/bridge/tfschema";
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
    const parsed = TYPES.repository.schema.parse({ ...state, owner: "Sanoma-AI" });
    expect(parsed).toMatchObject({ name, full_name: `Sanoma-AI/${name}`, fork: "false", pages: null });
    // `security_and_analysis` is a list of at most one in the provider's state: one object here.
    expect(parsed.security_and_analysis).toMatchObject({ secret_scanning: { status: "disabled" } });
  });

  it("parse the recorded read of a deploy key, by `<repository>:<key id>` at the provider", () => {
    const state = TYPES.repository_deploy_key.schema.parse(
      fromTfState(
        TYPES.repository_deploy_key.shape,
        recorded("github_repository_deploy_key/sanoma-apply-test_1000000101/read.json"),
      ),
    );
    expect(state).toMatchObject({
      id: "sanoma-apply-test:1000000101",
      repository: "sanoma-apply-test",
      read_only: true,
    });
    expect(declare.repository_deploy_key.bindingId(state)).toBe("sanoma-apply-test:1000000101");
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
    ["repository", "owner/name"],
    ["branch_protection", "repository_id:pattern"],
    ["team_membership", "owner/team_id:username"],
  ] as const)("reads and imports %s, effect read, by its %s", (type, identity) => {
    for (const op of [github[type].read, github[type].import]) {
      expect(op).toMatchObject({ vendor: "github", resource: type, effect: "read", idempotent: true });
    }
    expect(github[type].read.id).toBe(`github.${type}.read`);
    expect(declare[type].identity).toBe(identity);
  });

  it("keeps the resource types beside the connector's vendor", () => {
    expect(Object.keys(declare)).toEqual([
      "repository",
      "branch_protection",
      "team_membership",
      "repository_deploy_key",
    ]);
    expect(declare.repository.vendor).toBe("github");
  });

  it("declares resources for data files, named by their import ids, without what GitHub sets", () => {
    expect(() => declare.repository({ owner: "acme", name: "sanoma", html_url: "https://github.com/x" })).toThrow(
      "github.repository: leave out html_url: the vendor sets it",
    );
    // @ts-expect-error the owner is a fact about the repository: a data file states it
    expect(() => declare.repository({ name: "sanoma" })).toThrow(/owner/);
    expect(declare.repository({ owner: "acme", name: "sanoma", delete_branch_on_merge: true })).toMatchObject({
      vendor: "github",
      type: "repository",
      name: "acme/sanoma",
    });
    expect(declare.branch_protection({ repository_id: "acme/sanoma", pattern: "main" }).name).toBe("acme/sanoma:main");
    // A rule names its repository: the declared repository stands for `<owner>/<name>`, its owner with it.
    const site = declare.repository({ owner: "acme", name: "website" });
    expect(declare.branch_protection({ repository_id: site, pattern: "main" })).toMatchObject({
      name: "acme/website:main",
      desired: { repository_id: "acme/website", pattern: "main" },
      refs: { repository_id: "github.repository:acme/website" },
    });
    // @ts-expect-error only a repository
    expect(() => declare.team_membership({ owner: "acme", team_id: site, username: "octocat" })).toThrow(
      /team_id takes a value/,
    );
    expect(declare.team_membership({ owner: "acme", team_id: "core", username: "octocat" }).name).toBe(
      "acme/core:octocat",
    );
    // A deploy key names its repository the same way, and is found by its binding alone.
    const key = declare.repository_deploy_key({
      repository: site,
      title: "Sanoma host",
      key: "ssh-rsa AAAA",
      read_only: true,
    });
    expect(key).toMatchObject({
      desired: { repository: "acme/website" },
      refs: { repository: "github.repository:acme/website" },
    });
    expect(declare.repository_deploy_key.identity).toBeUndefined();
  });

  it("compares a repository's topics, a set, in any order, and only declared fields", () => {
    const state = { owner: "acme", name: "sanoma", topics: ["b", "a"], etag: 'W/"1"', has_wiki: true };
    const desired = { owner: "acme", name: "sanoma", topics: ["a", "b"] };
    expect(declare.repository.normalize(state, desired)).toEqual({ owner: "acme", name: "sanoma", topics: ["a", "b"] });
    expect(declare.repository.normalize(state, desired)).toEqual(declare.repository.normalize(desired, desired));
    // A branch protection rule's status checks are a set too, inside a block.
    const rule = { repository_id: "sanoma", pattern: "main", required_status_checks: [{ contexts: ["b", "a"] }] };
    const declared = { ...rule, required_status_checks: [{ contexts: ["a", "b"] }] };
    expect(declare.branch_protection.normalize(rule, declared)).toEqual(
      declare.branch_protection.normalize(declared, declared),
    );
  });
});
