import type { ResourcesConfig } from "@sanoma/workflows/tfschema";

/**
 * Which of the Stripe provider's resource types `pnpm generate` writes into `resources.gen.ts`,
 * and what its schema does not say. Hand-owned.
 */
export default {
  // stripe/stripe 0.3.0: the sha256 of the release's SHA256SUMS (provider-bridge testdata/pins.json).
  sha256: "2e3ae569e1bee7c64ae7f10e6ceaaf5bfab4db7af38979bab28f9b7a35a260c5",
  types: ["stripe_product", "stripe_webhook_endpoint"],
  // Create-only in Stripe's API (its update takes neither), so a change replaces the endpoint.
  immutable: {
    stripe_webhook_endpoint: ["api_version", "connect"],
  },
} satisfies ResourcesConfig;
