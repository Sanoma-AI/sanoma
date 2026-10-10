import type { ProviderClient } from "@sanoma/bridge";
import { DriverError } from "@sanoma/workflows";
import { z } from "zod";
import { githubTf } from "./connector.ts";

export interface GithubDriverOptions {
  /** The provider bridge, started by the config (`startBridge`). One per tenant: it holds the token once configured. */
  bridge: ProviderClient;
  /** The organization or user whose resources the ids name. Default: the token's own user. */
  owner?: string;
}

/** The environment variable the driver reads, on every call. */
const env = z.object({
  GITHUB_TOKEN: z
    .string()
    .min(1)
    .describe(
      "a fine-grained token with read-only repository permissions, limited to the repositories the data files declare",
    ),
});

/**
 * Reads GitHub resources through the `integrations/github` OpenTofu provider on `bridge`, with
 * the token in `GITHUB_TOKEN`, read on every call. The provider is configured on the first call,
 * and again when the token changes or the provider has exited.
 */
export function githubDriver({ bridge, owner }: GithubDriverOptions) {
  const driver = githubTf.driver(bridge, () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new DriverError("github: GITHUB_TOKEN is not set", { retryable: false });
    return { owner: owner ?? null, token };
  });
  return Object.freeze({ ...driver, env });
}
