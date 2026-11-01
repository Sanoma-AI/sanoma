import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { type CallContext, type Driver, DriverError, defineDriver, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";
import { Account, githubApp, githubTf } from "./connector.ts";
import { owned } from "./owner.ts";
import {
  appJwtOf,
  branchPath,
  failed as failure,
  GITHUB_APP_SECRETS,
  installationToken,
  ok,
  read,
  repoPath,
  send,
} from "./rest.ts";

export interface GithubDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call (`startBridge`'s binary). One per tenant: it holds the token once configured.
   */
  bridge?: ProviderClient;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  // Optional: the operations through the App read the App's keys instead, and the resources' refuse without it.
  GITHUB_TOKEN: z
    .string()
    .min(1)
    .optional()
    .describe(
      "a fine-grained token with read-only repository permissions, limited to the repositories the data files declare; the resource operations need it",
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
 * binding id) is resolved first, by GraphQL (`resolveNode`). The operations through the App
 * (`appDriver`) sign in with the App's keys instead.
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
  return Object.freeze({ ...driver, ops: Object.freeze({ ...driver.ops, ...appDriver.ops }), env });
}

/** A JWT of the App, signed with its keys from the call's secrets (what the app's Create GitHub App stores). */
async function jwtFor({ secrets }: CallContext): Promise<string> {
  const [id, pem] = await Promise.all([secrets.get(GITHUB_APP_SECRETS.id), secrets.get(GITHUB_APP_SECRETS.pem)]);
  const jwt = appJwtOf(id, pem);
  if (jwt) return jwt;
  throw new DriverError(`github: ${GITHUB_APP_SECRETS.id} and ${GITHUB_APP_SECRETS.pem} are not stored`, {
    retryable: false,
    vendorCode: "no_app",
  });
}

/** A token of the installation, minted for this call (for the repository `name` alone, when given) and never kept. */
const tokenFor = async (call: CallContext, installation: number, name?: string) =>
  (await installationToken(await jwtFor(call), installation, name)).token;

/** `<owner>/<name>` as its API path, and the name alone. */
function repoOf(repository: string) {
  const [owner = "", name = ""] = repository.split("/");
  return { path: repoPath(owner, name), name };
}

const Installation = z.object({
  id: z.number(),
  account: Account,
  repository_selection: z.enum(["all", "selected"]),
});
const Repository = z.object({
  id: z.number(),
  full_name: z.string(),
  clone_url: z.string(),
  ssh_url: z.string(),
  default_branch: z.string(),
});
const Ref = z.object({ object: z.object({ sha: z.string() }) });
const Sha = z.object({ sha: z.string() });
const Branch = z.object({ commit: z.object({ sha: z.string(), commit: z.object({ tree: Sha }) }) });

/**
 * The operations through the App, over GitHub's REST API: each mints an installation token from
 * the App's JWT when called (`installation.get` uses the JWT itself), which is never kept.
 */
const appDriver = defineDriver(githubApp, {
  installation: {
    async get({ id }, call) {
      const found = await ok(await jwtFor(call), "GET", `/app/installations/${id}`, Installation);
      return { id: found.id, account: found.account, repositorySelection: found.repository_selection };
    },
  },
  repository: {
    async generate({ installation, template, owner, name, private: isPrivate, description }, call) {
      const from = repoPath(template.owner, template.repository);
      const made = await ok(await tokenFor(call, installation), "POST", `${from}/generate`, Repository, {
        owner,
        name,
        private: isPrivate,
        include_all_branches: false,
        ...(description !== undefined && { description }),
      });
      return {
        id: made.id,
        fullName: made.full_name,
        cloneUrl: made.clone_url,
        sshUrl: made.ssh_url,
        defaultBranch: made.default_branch,
      };
    },
    // One commit with Git's data API: the branch's head and its tree, a tree over it with the files'
    // contents (GitHub writes their blobs), a commit on the head, and the branch moved to it.
    async commit({ installation, repository, branch, message, files }, call) {
      const repo = repoOf(repository);
      const token = await tokenFor(call, installation, repo.name);
      /** The branch's head commit and its tree, or undefined when the branch is not there. */
      const head = async (name: string) => {
        const path = `${repo.path}/branches/${branchPath(name)}`;
        const reply = await send(token, "GET", path);
        if (reply.status === 404) return undefined;
        if (reply.status >= 300) throw failure("GET", path, reply);
        const { commit } = read(Branch, reply.body, `GET ${path}`);
        return { sha: commit.sha, tree: commit.commit.tree.sha };
      };
      /** The default branch's head, which a branch not there yet starts from. */
      const start = async () => {
        const { default_branch } = await ok(token, "GET", repo.path, Repository.pick({ default_branch: true }));
        const found = await head(default_branch);
        if (found) return found;
        throw new DriverError(`github: ${repository} has no ${default_branch} to start ${branch} from`, {
          retryable: false,
          vendorCode: "no_branch",
        });
      };
      const existing = await head(branch);
      const parent = existing ?? (await start());
      const tree = await ok(token, "POST", `${repo.path}/git/trees`, Sha, {
        base_tree: parent.tree,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
      });
      const commit = await ok(token, "POST", `${repo.path}/git/commits`, Sha, {
        message,
        tree: tree.sha,
        parents: [parent.sha],
      });
      if (!existing) {
        await ok(token, "POST", `${repo.path}/git/refs`, Ref, { ref: `refs/heads/${branch}`, sha: commit.sha });
      } else {
        await ok(token, "PATCH", `${repo.path}/git/refs/heads/${branchPath(branch)}`, Ref, { sha: commit.sha });
      }
      return { sha: commit.sha };
    },
    async addDeployKey({ installation, repository, title, key, readOnly }, call) {
      const repo = repoOf(repository);
      const token = await tokenFor(call, installation, repo.name);
      const added = await ok(token, "POST", `${repo.path}/keys`, z.object({ id: z.number() }), {
        title,
        key,
        read_only: readOnly,
      });
      return { id: added.id };
    },
  },
});
