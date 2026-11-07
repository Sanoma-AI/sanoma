import { stripe } from "@sanoma-ai/connector-stripe/resources";

// Stripe names its objects, so each resource declares the id of one that exists, in test mode.
//
// Placeholders: there is no test-mode key yet to make the real ones with. These are the ids the
// Stripe fake holds, with its values, so Sandbox runs and the drift scenarios read them clean; a
// live drift run reports both as errors until they are replaced.
// With a test-mode key, create a product and a webhook endpoint with exactly the values below
// (name, description, active, metadata; url, enabled_events, description), then swap in their ids
// (see the README, "Resources and drift").

export const driftTestProduct = stripe.product({
  id: "prod_SanomaTest0001",
  name: "Sanoma test product",
  description: "A test-mode product Sanoma reads in its tests.",
  active: true,
  metadata: { owner: "sanoma" },
});

export const driftTestWebhook = stripe.webhook_endpoint({
  id: "we_SanomaTest0001",
  url: "https://example.com/sanoma/stripe-webhook",
  enabled_events: ["product.updated"],
  description: "Sanoma test endpoint",
});

export default [driftTestProduct, driftTestWebhook];
