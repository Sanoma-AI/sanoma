import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { type CallContext, type Driver, DriverError, defineDriver, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";
import { Account, githubApp, githubTf, keyText } from "./connector.ts";
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

const Key = z.object({ id: z.number(), key: z.string() });

/**
 * The deploy key `<owner>/<repository>:<key text>` names (`isKeyIdentity`), among the repository's
 * first 100: its owner and the provider's import id, `<repository>:<key id>`; undefined when the
 * repository has no such key. GitHub keeps a key without its comment.
 */
async function resolveKey(identity: string, token: string) {
  const at = /^([^/]+)\/([^:]+):(.+)$/.exec(identity);
  if (!at) return undefined;
  const [, owner = "", name = "", text = ""] = at;
  const path = `${repoPath(owner, name)}/keys?per_page=100`;
  const reply = await send(token, "GET", path);
  // No repository (not made yet) holds no key: the key is made, after it.
  if (reply.status === 404) return undefined;
  if (reply.status >= 300) throw failure("GET", path, reply);
  const there = read(z.array(Key), reply.body, `GET ${path}`).find((k) => k.key === keyText(text));
  return there && { owner, id: `${name}:${there.id}` };
}

/** The token, from the environment, read on every call. */
function readToken() {
  const value = process.env.GITHUB_TOKEN;
  // Optional in `env` (the operations through the App need none), so the hint the env guard gives is here.
  if (!value)
    throw new DriverError("github: GITHUB_TOKEN is not set; set it on the connector page", { retryable: false });
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
  const driver = owned(driverFor, (type, id) =>
    type === "repository_deploy_key" ? resolveKey(id, readToken()) : resolveNode(id, readToken()),
  );
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
  template_repository: z.object({ full_name: z.string() }).nullish(),
});
const Ref = z.object({ object: z.object({ sha: z.string() }) });
const Sha = z.object({ sha: z.string() });
const Branch = z.object({
  commit: z.object({ sha: z.string(), commit: z.object({ message: z.string(), tree: Sha }) }),
});

/** Whether `reply` is GitHub's 422 saying `what` (one of its validation errors). */
const refused = (reply: { status: number; body: any }, what: RegExp) =>
  reply.status === 422 && what.test(JSON.stringify(reply.body?.errors ?? reply.body?.message ?? ""));

/** How long, and how often, a commit waits for a repository just generated to fill from its template. */
const FILL_TRIES = 10;
const FILL_WAIT_MS = 1000;

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
      const token = await tokenFor(call, installation);
      const path = `${repoPath(template.owner, template.repository)}/generate`;
      const reply = await send(token, "POST", path, {
        owner,
        name,
        private: isPrivate,
        include_all_branches: false,
        ...(description !== undefined && { description }),
      });
      let made: z.infer<typeof Repository>;
      if (reply.status < 300) made = read(Repository, reply.body, `POST ${path}`);
      else if (refused(reply, /already exists/i)) {
        // Made already, by an earlier try of the same step whose answer was lost: that one, when it is from the template.
        const there = await ok(token, "GET", repoPath(owner, name), Repository);
        const wanted = `${template.owner}/${template.repository}`.toLowerCase();
        if (there.template_repository?.full_name.toLowerCase() !== wanted) throw failure("POST", path, reply);
        made = there;
      } else throw failure("POST", path, reply);
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
        // 409: an empty repository, as one just generated is until its template's copy lands.
        if (reply.status === 404 || reply.status === 409) return undefined;
        if (reply.status >= 300) throw failure("GET", path, reply);
        const { commit } = read(Branch, reply.body, `GET ${path}`);
        return { sha: commit.sha, tree: commit.commit.tree.sha, message: commit.commit.message };
      };
      /**
       * The default branch's head, which a branch not there yet starts from; waited for, since a
       * repository just generated fills from its template in the background.
       */
      const start = async () => {
        const { default_branch } = await ok(token, "GET", repo.path, Repository.pick({ default_branch: true }));
        for (let i = 0; i < FILL_TRIES; i++) {
          if (i) await new Promise((resolve) => setTimeout(resolve, FILL_WAIT_MS));
          const found = await head(default_branch);
          if (found) return found;
        }
        throw new DriverError(`github: ${repository} has no ${default_branch} to start ${branch} from`, {
          retryable: true,
          vendorCode: "no_branch",
        });
      };
      const existing = await head(branch);
      const parent = existing ?? (await start());
      const tree = await ok(token, "POST", `${repo.path}/git/trees`, Sha, {
        base_tree: parent.tree,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
      });
      // The head is this commit already (an earlier try of the same step whose answer was lost).
      if (existing && tree.sha === parent.tree && parent.message === message) return { sha: parent.sha };
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
    async head({ installation, repository, branch }, call) {
      const repo = repoOf(repository);
      const token = await tokenFor(call, installation, repo.name);
      const path = `${repo.path}/branches/${branchPath(branch)}`;
      const reply = await send(token, "GET", path);
      // 409: an empty repository, as one just generated is until its template's copy lands: tried again.
      if (reply.status === 409) {
        throw new DriverError(`github: ${repository} is empty until its template's copy lands`, {
          retryable: true,
          status: 409,
          vendorCode: "no_branch",
        });
      }
      if (reply.status >= 300) throw failure("GET", path, reply);
      return { sha: read(Branch, reply.body, `GET ${path}`).commit.sha };
    },
    async addDeployKey({ installation, repository, title, key, readOnly }, call) {
      const repo = repoOf(repository);
      const token = await tokenFor(call, installation, repo.name);
      const path = `${repo.path}/keys`;
      const reply = await send(token, "POST", path, { title, key, read_only: readOnly });
      if (reply.status < 300) return { id: read(Key, reply.body, `POST ${path}`).id };
      // Added already, by an earlier try of the same step whose answer was lost: GitHub keeps the key without its comment.
      if (refused(reply, /already in use/i)) {
        const there = (await ok(token, "GET", `${path}?per_page=100`, z.array(Key))).find(
          (k) => k.key === keyText(key),
        );
        if (there) return { id: there.id };
      }
      throw failure("POST", path, reply);
    },
  },
});
