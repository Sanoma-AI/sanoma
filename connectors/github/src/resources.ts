import { defineResource } from "@sanoma/workflows";
import { github_branch_protection, github_repository, github_team_membership } from "./resources.gen.ts";

// The GitHub resource types Sanoma reads, from the OpenTofu provider's schema (`resources.gen.ts`),
// with what the schema does not say: how each is found, and how it is compared.

export const repository = defineResource({
  vendor: "github",
  type: "repository",
  title: "Repository",
  identity: "name",
  schema: github_repository.schema,
  fields: github_repository.fields,
  find: ({ name }) => name,
});

export const branchProtection = defineResource({
  vendor: "github",
  type: "branch_protection",
  title: "Branch protection rule",
  identity: "repository_id:pattern",
  schema: github_branch_protection.schema,
  fields: github_branch_protection.fields,
  find: ({ repository_id, pattern }) => `${repository_id}:${pattern}`,
});

export const teamMembership = defineResource({
  vendor: "github",
  type: "team_membership",
  title: "Team membership",
  identity: "team_id:username",
  schema: github_team_membership.schema,
  fields: github_team_membership.fields,
  find: ({ team_id, username }) => `${team_id}:${username}`,
});

/**
 * The constructors a data file declares GitHub resources with:
 * `export const site = github.repository({ name: "website", has_wiki: false })`.
 */
export const github = {
  repository,
  branch_protection: branchProtection,
  team_membership: teamMembership,
};
