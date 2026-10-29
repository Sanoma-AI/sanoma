import { tfConnector } from "@sanoma-ai/bridge/connector";
import { vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";
import {
  github_branch_protection,
  github_repository,
  github_repository_deploy_key,
  github_team_membership,
  provider,
} from "./resources.gen.ts";

/**
 * `type` with an `owner` field: the organization or user it belongs to, which the provider takes
 * as its configuration, not as an attribute. A data file always declares it; the driver
 * configures the provider for it on each call (`owned`).
 */
const withOwner = <T extends typeof github_repository | typeof github_team_membership>(type: T, what: string) => ({
  ...type,
  schema: type.schema.extend({ owner: z.string().min(1).describe(what) }),
});

/**
 * GitHub, through the `integrations/github` OpenTofu provider: the generated resource types,
 * what their schema does not say (how each is found), and who GitHub is. The connector, the
 * data-file constructors, the driver and the fake all come from this one record.
 */
export const githubTf = tfConnector({
  vendor: "github",
  provider,
  types: {
    // Named `<owner>/<name>`, as GitHub's `full_name`. Bound by its node id, which a rename keeps,
    // as a rule is by its own (its `id`); the driver resolves either to what the provider imports by.
    repository: {
      tf: withOwner(github_repository, "The organization or user the repository belongs to"),
      title: "Repository",
      identity: "owner/name",
      // An empty name names nothing: the type then says its identity is missing.
      find: ({ owner, name }) => (name ? `${owner}/${name}` : ""),
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
      tf: withOwner(github_team_membership, "The organization the team is in"),
      title: "Team membership",
      identity: "owner/team_id:username",
      find: ({ owner, team_id, username }) => `${owner}/${team_id}:${username}`,
    },
    // An SSH key that may clone one repository: a host's, read-only. Found only by its binding,
    // `<owner>/<repository>:<key id>`; apply creates and deletes it (GitHub changes none).
    repository_deploy_key: {
      tf: github_repository_deploy_key,
      title: "Deploy key",
      writable: true,
    },
  },
  // A data file names a repository by the declared one, which stands for `<owner>/<name>`: so a
  // rule and a deploy key take their owner from it. GitHub holds a rule's repository by its node
  // id (`R_…`); a deploy key's `repository` is `<owner>/<name>`, the provider's name with its owner.
  references: {
    branch_protection: { repository_id: { type: "github.repository", by: ["name", "node_id"] } },
    repository_deploy_key: { repository: { type: "github.repository" } },
  },
  // The provider answers an import of a rule that is not there `failed_precondition`, saying it
  // "could not find" it (recorded: testdata/replies/…/github_branch_protection/provider-bridge_main).
  missing: (e) =>
    e.code === "not_found" ||
    (e.code === "failed_precondition" && e.diagnostics.some((d) => d.summary.startsWith("could not find "))),
  info: vendorInfo(import.meta.url),
});
