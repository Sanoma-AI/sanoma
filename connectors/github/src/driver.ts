import { defaultBridge, type ProviderClient } from "@sanoma/bridge";
import { DriverError } from "@sanoma/workflows";
import { z } from "zod";
import { githubTf } from "./connector.ts";

export interface GithubDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call from `SANOMA_BRIDGE_BIN`. One per tenant: it holds the token once configured.
   */
  bridge?: ProviderClient;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  GITHUB_TOKEN: z
    .string()
    .min(1)
    .describe(
      "a fine-grained token with read-only repository permissions, limited to the repositories the data files declare",
    ),
  GITHUB_OWNER: z
    .string()
    .min(1)
    .optional()
    .describe("the organization or user whose repositories the data files describe; default: the token's own user"),
});

/**
 * Reads GitHub resources through the `integrations/github` OpenTofu provider on `bridge` (the
 * default bridge when none is given), with the token in `GITHUB_TOKEN` and the owner in
 * `GITHUB_OWNER`, read on every call. The provider is configured on the first call, and again
 * when the token or the owner changes or the provider has exited.
 */
export function githubDriver({ bridge = defaultBridge() }: GithubDriverOptions = {}) {
  const driver = githubTf.driver(bridge, () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new DriverError("github: GITHUB_TOKEN is not set", { retryable: false });
    return { owner: process.env.GITHUB_OWNER || null, token };
  });
  return Object.freeze({ ...driver, env });
}
