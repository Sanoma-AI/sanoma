import type { ResourcesConfig } from "@sanoma/bridge/tfschema";

/**
 * Which of the GitHub provider's resource types `pnpm generate` writes into `resources.gen.ts`,
 * and what its schema does not say. Hand-owned. The release and its sha256 are the pin in
 * `@sanoma/bridge`'s `testdata/pins.json`.
 */
export default {
  provider: "integrations/github",
  types: ["github_repository", "github_branch_protection", "github_team_membership"],
  // ForceNew in the provider's source: a change replaces the object. The schema has no such flag.
  immutable: {
    github_branch_protection: ["repository_id"],
    github_team_membership: ["team_id", "username"],
  },
} satisfies ResourcesConfig;
