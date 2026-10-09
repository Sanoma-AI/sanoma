import { defineResource } from "@sanoma/workflows";
import { stripe_product, stripe_webhook_endpoint } from "./resources.gen.ts";

// The Stripe resource types Sanoma reads, from the OpenTofu provider's schema (`resources.gen.ts`),
// with what the schema does not say: how each is found. Both are named by Stripe's own id, which
// Stripe sets: a data file names an object that exists.

/** Stripe's id of a declared object, which the data file must give. */
const idOf = ({ id }: { id?: string | null }) => id ?? "";

export const product = defineResource({
  vendor: "stripe",
  type: "product",
  title: "Product",
  identity: "id",
  schema: stripe_product.schema,
  fields: stripe_product.fields,
  find: idOf,
});

export const webhookEndpoint = defineResource({
  vendor: "stripe",
  type: "webhook_endpoint",
  title: "Webhook endpoint",
  identity: "id",
  schema: stripe_webhook_endpoint.schema,
  fields: stripe_webhook_endpoint.fields,
  find: idOf,
});

/**
 * The constructors a data file declares Stripe resources with:
 * `export const plan = stripe.product({ id: "prod_…", name: "Pro" })`.
 */
export const stripe = {
  product,
  webhook_endpoint: webhookEndpoint,
};
