import { tfConnector } from "@sanoma-ai/bridge/connector";
import { vendorInfo } from "@sanoma-ai/workflows";
import { github_branch_protection, github_repository, github_team_membership, provider } from "./resources.gen.ts";

/**
 * GitHub, through the `integrations/github` OpenTofu provider: the generated resource types,
 * what their schema does not say (how each is found), and who GitHub is. The connector, the
 * data-file constructors, the driver and the fake all come from this one record.
 */
export const githubTf = tfConnector({
  vendor: "github",
  provider,
  types: {
    // Bound by its node id, which a rename keeps, as a rule is by its own (its `id`); the driver
    // resolves either to what the provider imports by.
    repository: {
      tf: github_repository,
      title: "Repository",
      identity: "name",
      find: ({ name }) => name,
      bindingId: ({ node_id }) => String(node_id),
      // Apply creates, changes and deletes repositories.
      writable: true,
    },
    branch_protection: {
      tf: github_branch_protection,
      title: "Branch protection rule",
      identity: "repository_id:pattern",
      find: ({ repository_id, pattern }) => `${repository_id}:${pattern}`,
    },
    team_membership: {
      tf: github_team_membership,
      title: "Team membership",
      identity: "team_id:username",
      find: ({ team_id, username }) => `${team_id}:${username}`,
    },
  },
  // GitHub holds a rule's repository by its node id (`R_…`); a data file names it by its name.
  references: { branch_protection: { repository_id: { type: "github.repository", by: ["name", "node_id"] } } },
  // The provider answers an import of a rule that is not there `failed_precondition`, saying it
  // "could not find" it (recorded: testdata/replies/…/github_branch_protection/provider-bridge_main).
  missing: (e) =>
    e.code === "not_found" ||
    (e.code === "failed_precondition" && e.diagnostics.some((d) => d.summary.startsWith("could not find "))),
  info: vendorInfo(import.meta.url),
});
