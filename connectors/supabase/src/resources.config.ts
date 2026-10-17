import type { ResourcesConfig } from "@sanoma-ai/bridge/tfschema";

/**
 * Which of the Supabase provider's resource types `pnpm generate` writes into `resources.gen.ts`,
 * and what its schema does not say. Hand-owned. The release and its sha256 are the pin in
 * `@sanoma-ai/bridge`'s `testdata/pins.json`.
 */
export default {
  provider: "supabase/supabase",
  types: ["supabase_project"],
  // The provider's update refuses both ("Update is not supported for this attribute"), so a
  // change replaces the project.
  immutable: {
    supabase_project: ["organization_id", "region"],
  },
} satisfies ResourcesConfig;
