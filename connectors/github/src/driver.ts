import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { DriverError, retryableStatus } from "@sanoma-ai/workflows";
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
 * The node ids a binding keeps that the provider cannot import by, by type: a repository's (`R_…`,
 * or the legacy base64 of `010:Repository…`) and a branch protection rule's (`BPR_…`).
 */
const NODE_IDS: Readonly<Record<string, RegExp>> = {
  repository: /^(R_[\w-]+|MDEwOlJlcG9zaXRvcnk[\w+/=]+)$/,
  branch_protection: /^BPR_[\w-]+$/,
};

const NODE_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Repository { name owner { login } }
    ... on BranchProtectionRule { pattern repository { name owner { login } } }
  }
  viewer { login }
}`;

const Repo = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const NodeReply = z.object({
  data: z
    .object({
      node: Repo.partial().extend({ pattern: z.string().optional(), repository: Repo.optional() }).nullable(),
      viewer: z.object({ login: z.string() }),
    })
    .nullish(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
  message: z.string().optional(),
});

/**
 * The provider's import id for a node id, from one GraphQL `node(id)` query: a repository's
 * name, a rule's `repository:pattern`. Refused when the repository is not the provider's owner's
 * (`GITHUB_OWNER`, else the token's user). The id itself when GitHub has no such node, so the
 * import says it is gone.
 */
async function importIdOf(id: string, { token, owner }: { token: string; owner: string | null }) {
  let status: number;
  let json: unknown;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: NODE_QUERY, variables: { id } }),
    });
    status = res.status;
    json = await res.json().catch(() => undefined);
  } catch (cause) {
    throw new DriverError(`github: resolving the node ${id}: the request failed`, { retryable: true, cause });
  }
  const reply = NodeReply.safeParse(json).data;
  // GraphQL answers an id it has no node for with a null node and a NOT_FOUND error.
  const failed = reply?.errors?.find((e) => e.type !== "NOT_FOUND");
  if (status !== 200 || !reply?.data || failed) {
    throw new DriverError(
      `github: resolving the node ${id}: ${failed?.message ?? reply?.message ?? `HTTP ${status}`}`,
      {
        retryable: retryableStatus(status),
        status,
        ...(failed?.type && { vendorCode: failed.type }),
      },
    );
  }
  const { node, viewer } = reply.data;
  const repo = node?.repository ?? (node?.name && node.owner ? { name: node.name, owner: node.owner } : undefined);
  if (!repo) return id;
  const expected = owner ?? viewer.login;
  if (repo.owner.login.toLowerCase() !== expected.toLowerCase()) {
    throw new DriverError(`github: ${id} is in ${repo.owner.login}/${repo.name}, not a repository of ${expected}`, {
      retryable: false,
    });
  }
  return node?.pattern === undefined ? repo.name : `${repo.name}:${node.pattern}`;
}

/** The provider's config, from the environment, read on every call. */
function config() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new DriverError("github: GITHUB_TOKEN is not set", { retryable: false });
  return { owner: process.env.GITHUB_OWNER || null, token };
}

/**
 * Reads GitHub resources through the `integrations/github` OpenTofu provider on `bridge` (the
 * default bridge when none is given), with the token in `GITHUB_TOKEN` and the owner in
 * `GITHUB_OWNER`, read on every call. The provider is configured on the first call, and again
 * when the token or the owner changes or the provider has exited. A repository's or a rule's
 * import takes its node id (its binding id) too, resolved first (`importIdOf`).
 */
export function githubDriver({ bridge = defaultBridge() }: GithubDriverOptions = {}) {
  const driver = githubTf.driver(bridge, config, (type, id) =>
    NODE_IDS[type]?.test(id) ? importIdOf(id, config()) : id,
  );
  return Object.freeze({ ...driver, env });
}
