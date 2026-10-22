import { tfConnector } from "@sanoma-ai/bridge/connector";
import { vendorInfo } from "@sanoma-ai/workflows";
import { provider, stripe_product, stripe_webhook_endpoint } from "./resources.gen.ts";

/**
 * Stripe, through the `stripe/stripe` OpenTofu provider: the generated resource types, and who
 * Stripe is. Stripe names its objects, so a declaration has no identity: its object is the one
 * its binding names, by Stripe's id. The connector, the data-file constructors, the driver and
 * the fake all come from this one record.
 */
export const stripeTf = tfConnector({
  vendor: "stripe",
  provider,
  types: {
    product: { tf: stripe_product, title: "Product" },
    webhook_endpoint: { tf: stripe_webhook_endpoint, title: "Webhook endpoint" },
  },
  info: vendorInfo(import.meta.url),
});
