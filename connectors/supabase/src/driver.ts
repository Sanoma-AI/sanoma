import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { DriverError } from "@sanoma-ai/workflows";
import { z } from "zod";
import { supabaseTf } from "./connector.ts";

export interface SupabaseDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call (`startBridge`'s binary). One per tenant: it holds the token once configured.
   */
  bridge?: ProviderClient;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  SUPABASE_ACCESS_TOKEN: z
    .string()
    .min(1)
    .describe("a personal access token that can read the projects the data files declare"),
});

/**
 * Reads Supabase projects through the `supabase/supabase` OpenTofu provider on `bridge` (the
 * default bridge when none is given), with the access token in `SUPABASE_ACCESS_TOKEN`, read on
 * every call. The provider is configured on the first call, and again when the token changes or
 * the provider has exited.
 */
export function supabaseDriver({ bridge = defaultBridge() }: SupabaseDriverOptions = {}) {
  const driver = supabaseTf.driver(bridge, () => {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!token) throw new DriverError("supabase: SUPABASE_ACCESS_TOKEN is not set", { retryable: false });
    return { access_token: token, endpoint: null };
  });
  return Object.freeze({ ...driver, env });
}
