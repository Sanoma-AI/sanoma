import { stripeTf } from "./connector.ts";

/**
 * Stripe resources, read through the `stripe/stripe` OpenTofu provider: each type has a `read`
 * and an `import` operation (`stripe.product.read`), both effect `read`.
 */
export const stripe = stripeTf.connector;
