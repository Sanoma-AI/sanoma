import { github } from "@sanoma-ai/connector-github/resources";

// Two of Sanoma-AI's public repositories on GitHub. Each declares only the settings we mean to
// own: a field left out is GitHub's to set, and never drift. `sanoma` guards `main` with a
// repository ruleset ("Require pull requests"), not classic branch protection, and
// `provider-bridge`'s `main` is unprotected, so there is no `github.branch_protection` here; the
// org has no teams, so no `github.team_membership`.

export const providerBridge = github.repository({
  owner: "Sanoma-AI",
  name: "provider-bridge",
  description:
    "Go sidecar loading Terraform/OpenTofu providers (Okta, Stripe, Google Workspace) over the plugin protocol and serving them to the Sanoma planner",
  visibility: "public",
  has_issues: true,
  has_wiki: true,
  has_projects: true,
  has_discussions: false,
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  allow_auto_merge: false,
  delete_branch_on_merge: false,
  archived: false,
});

export const sanoma = github.repository({
  owner: "Sanoma-AI",
  name: "sanoma",
  description:
    "Open core: schema, planner, Cedar policies, ledger format, MCP server, local studio, CLI, first-party connectors, modules",
  visibility: "public",
  has_issues: true,
  has_wiki: false,
  has_projects: true,
  has_discussions: false,
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  allow_auto_merge: false,
  delete_branch_on_merge: false,
  archived: false,
});

export default [providerBridge, sanoma];
