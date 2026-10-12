import { defaultBridge, type ProviderClient } from "@sanoma/bridge";
import { DriverError } from "@sanoma/workflows";
import { z } from "zod";
import { stripeTf } from "./connector.ts";

export interface StripeDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call from `SANOMA_BRIDGE_BIN`. One per tenant: it holds the key once configured.
   */
  bridge?: ProviderClient;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  STRIPE_API_KEY: z
    .string()
    .min(1)
    .describe("a secret or restricted key that can read the resources the data files declare"),
});

/**
 * Reads Stripe resources through the `stripe/stripe` OpenTofu provider on `bridge` (the default
 * bridge when none is given), with the secret key in `STRIPE_API_KEY`, read on every call. The
 * provider is configured on the first call, and again when the key changes or the provider has
 * exited.
 */
export function stripeDriver({ bridge = defaultBridge() }: StripeDriverOptions = {}) {
  const driver = stripeTf.driver(bridge, () => {
    const key = process.env.STRIPE_API_KEY;
    if (!key) throw new DriverError("stripe: STRIPE_API_KEY is not set", { retryable: false });
    return { api_key: key, stripe_account: null };
  });
  return Object.freeze({ ...driver, env });
}
