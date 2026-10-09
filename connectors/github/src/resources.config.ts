import type { ResourcesConfig } from "@sanoma/workflows/tfschema";

/**
 * Which of the GitHub provider's resource types `pnpm generate` writes into `resources.gen.ts`,
 * and what its schema does not say. Hand-owned.
 */
export default {
  // integrations/github 6.13.0: the sha256 of the release's SHA256SUMS (provider-bridge testdata/pins.json).
  sha256: "2d688e8383ff669297bbb6461f7eb05168f53fe76d3233fdb431e318efedb98f",
  types: ["github_repository", "github_branch_protection", "github_team_membership"],
  // ForceNew in the provider's source: a change replaces the object. The schema has no such flag.
  immutable: {
    github_branch_protection: ["repository_id"],
    github_team_membership: ["team_id", "username"],
  },
} satisfies ResourcesConfig;
