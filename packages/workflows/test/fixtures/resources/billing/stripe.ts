import { stripe } from "@sanoma/connector-stripe/resources";

// Stripe names its objects: each declares the id of one that exists (test mode).

export const pro = stripe.product({
  id: "prod_SanomaFixturePro",
  name: "Sanoma Pro",
  active: true,
  metadata: { tier: "pro" },
});

export const events = stripe.webhook_endpoint({
  id: "we_SanomaFixtureEvents",
  url: "https://example.com/stripe/events",
  enabled_events: ["customer.subscription.created", "invoice.paid"],
  description: "Billing events",
});

export default [pro, events];
