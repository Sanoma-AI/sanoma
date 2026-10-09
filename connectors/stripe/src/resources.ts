import { stripeTf } from "./connector.ts";

/**
 * The constructors a data file declares Stripe resources with, by Stripe's id:
 * `export const plan = stripe.product({ id: "prod_…", name: "Pro" })`.
 */
export const stripe = stripeTf.resources;
