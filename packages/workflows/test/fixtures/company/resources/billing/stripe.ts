import { stripe } from "@sanoma-ai/connector-stripe/resources";

// Stripe names its objects, so a declaration names none: the lockfile binds `pro` to a product
// (test mode), and `events` to nothing yet.

export const pro = stripe.product({
  name: "Sanoma Pro",
  active: true,
  metadata: { tier: "pro" },
});

export const events = stripe.webhook_endpoint({
  url: "https://example.com/stripe/events",
  enabled_events: ["customer.subscription.created", "invoice.paid"],
  description: "Billing events",
});

export default [pro, events];
