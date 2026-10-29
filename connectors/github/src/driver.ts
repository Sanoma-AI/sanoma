import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { type Driver, DriverError, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";
import { githubTf } from "./connector.ts";
import { owned } from "./owner.ts";

export interface GithubDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call (`startBridge`'s binary). One per tenant: it holds the token once configured.
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
});

const NODE_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Repository { name owner { login } }
    ... on BranchProtectionRule { pattern repository { name owner { login } } }
  }
}`;

const Repo = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const NodeReply = z.object({
  data: z
    .object({
      node: Repo.partial().extend({ pattern: z.string().optional(), repository: Repo.optional() }).nullable(),
    })
    .nullish(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
  message: z.string().optional(),
});

/**
 * A node id's repository owner and the provider's import id, from one GraphQL `node(id)` query:
 * a repository's name, a rule's `repository:pattern`. Undefined when GitHub has no such node.
 */
async function resolveNode(id: string, token: string) {
  let status: number;
  let json: unknown;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: NODE_QUERY, variables: { id } }),
      signal: AbortSignal.timeout(30_000),
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
        retryable: retryableStatus(status) || failed?.type === "RATE_LIMITED",
        status,
        ...(failed?.type && { vendorCode: failed.type }),
      },
    );
  }
  const { node } = reply.data;
  const repo = node?.repository ?? (node?.name && node.owner ? { name: node.name, owner: node.owner } : undefined);
  if (!repo) return undefined;
  return { owner: repo.owner.login, id: node?.pattern === undefined ? repo.name : `${repo.name}:${node.pattern}` };
}

/** The token, from the environment, read on every call. */
function readToken() {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new DriverError("github: GITHUB_TOKEN is not set", { retryable: false });
  return value;
}

/**
 * Reads GitHub resources through the `integrations/github` OpenTofu provider on `bridge` (the
 * default bridge when none is given), with the token in `GITHUB_TOKEN`, read on every call, for
 * the owner each call names (`owned`): the provider is configured with `{ owner, token }` on the
 * first call, and again when either changes or the provider has exited; a call for another owner
 * waits for those running for the one configured. A repository's or a rule's node id (its
 * binding id) is resolved first, by GraphQL (`resolveNode`).
 */
export function githubDriver({ bridge = defaultBridge() }: GithubDriverOptions = {}) {
  const drivers = new Map<string, Driver>();
  const driverFor = (owner: string | undefined) => {
    const key = owner?.toLowerCase() ?? "";
    let driver = drivers.get(key);
    if (!driver) drivers.set(key, (driver = githubTf.driver(bridge, () => ({ owner, token: readToken() }))));
    return driver;
  };
  const driver = owned(driverFor, (_, id) => resolveNode(id, readToken()));
  return Object.freeze({ ...driver, env });
}
