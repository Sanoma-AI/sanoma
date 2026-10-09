import type { ResourcesConfig } from "@sanoma/bridge/tfschema";

/**
 * Which of the Stripe provider's resource types `pnpm generate` writes into `resources.gen.ts`,
 * and what its schema does not say. Hand-owned. The release and its sha256 are the pin in
 * `@sanoma/bridge`'s `testdata/pins.json`.
 */
export default {
  provider: "stripe/stripe",
  types: ["stripe_product", "stripe_webhook_endpoint"],
  // Create-only in Stripe's API (its update takes neither), so a change replaces the endpoint.
  immutable: {
    stripe_webhook_endpoint: ["api_version", "connect"],
  },
} satisfies ResourcesConfig;
