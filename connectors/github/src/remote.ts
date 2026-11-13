import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CLOUD_TOKEN,
  cloudRun,
  DriverError,
  type HostEnforcement,
  type PullRequest,
  type RemoteContext,
  type RemoteEvent,
  type RemoteHalf,
  type RepoRef,
  type SourceHost,
} from "sanoma/workflows";
import { z } from "zod";
import { githubApp } from "./connector.ts";
import {
  appJwtOf,
  branchPath,
  failed,
  GITHUB_APP_SECRETS,
  installationToken,
  limited,
  ok,
  read,
  repoPath,
  send,
} from "./rest.ts";

export { appJwt, GITHUB_APP_SECRETS } from "./rest.ts";

// GitHub's remote half: a repository's pull requests, the `sanoma` commit status, the rules on a
// branch and the App's webhooks, over GitHub's REST API with plain `fetch`. It signs in as the
// company's GitHub App when the App is installed on the owner, else with `GITHUB_TOKEN`, else, on
// Sanoma Cloud, with a token Sanoma's own App mints for the company's repository (`cloud-token`).

/** A person's token, the one the resources' driver reads too. */
const TOKEN = "GITHUB_TOKEN";

/** The commit status's name, which a ruleset's required check names. */
const CONTEXT = "sanoma";

/** What `enforcement` says when GitHub refuses to read a branch's rules (a private repository on Free). */
const NO_RULES = "On a private repository this needs GitHub Team or Pro, or a public repository.";

const Installation = z.object({ id: z.number(), account: z.object({ login: z.string(), type: z.string() }) });

/** A JWT of the App, when its keys are among `found`. */
const jwtOf = (found: Map<string, string>) =>
  appJwtOf(found.get(GITHUB_APP_SECRETS.id), found.get(GITHUB_APP_SECRETS.pem));

/** The App itself, as GitHub lists it to the App: what it may do. */
const App = z.object({ permissions: z.record(z.string(), z.string()) });
const installations = (jwt: string) => ok(jwt, "GET", "/app/installations?per_page=100", z.array(Installation));

/**
 * An installation token of the App, when its keys are among `found` and it is installed on
 * `owner`; for the repository `name` alone when given, which GitHub refuses (422) when the
 * installation does not cover it.
 */
async function appToken(found: Map<string, string>, owner: string, name?: string): Promise<Minted | undefined> {
  const jwt = jwtOf(found);
  if (!jwt) return undefined;
  const installation = (await installations(jwt)).find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
  if (!installation) return undefined;
  return installationToken(jwt, installation.id, name);
}

/** A token, with when an installation token's hour is out. */
interface Minted {
  token: string;
  expiresAt?: number;
}

/**
 * A token for the repository `<owner>/<name>` alone from Sanoma Cloud, whose control plane holds
 * Sanoma's GitHub App and mints it (sanoma-ops's `cloud-token`), with its expiry.
 */
async function cloudToken(cloud: string, owner: string, name: string): Promise<Minted> {
  const output = await cloudRun("cloud-token", { repository: `${owner}/${name}`, scope: "write" }, { token: cloud });
  const minted = read(githubApp.repository.token.output, output, "Sanoma Cloud's cloud-token");
  return { token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
}

/**
 * The token `githubToken` chooses (an installation token for the repository `name` alone, when
 * given), with its expiry: then, with neither the App nor `GITHUB_TOKEN`, Sanoma Cloud's for it.
 */
async function mint(
  secrets: RemoteContext["secrets"],
  owner: string,
  prefer: "app" | "token",
  name?: string,
): Promise<Minted> {
  const found = await secrets([TOKEN, GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem, CLOUD_TOKEN]);
  const token = found.get(TOKEN);
  if (prefer === "token" && token) return { token };
  const app = await appToken(found, owner, name).catch((err: unknown) => {
    // The App's keys stored but not working (a deleted App, a bad key, GitHub down): the person's token, when there is one.
    if (token) return undefined;
    throw err instanceof DriverError
      ? err
      : new DriverError("github: signing as the GitHub App failed", { retryable: false, cause: err });
  });
  if (app) return app;
  if (token) return { token };
  const cloud = found.get(CLOUD_TOKEN);
  if (cloud && name !== undefined) return cloudToken(cloud, owner, name);
  throw new DriverError(`github: no ${TOKEN}, and the GitHub App is not installed on ${owner}`, {
    retryable: false,
    vendorCode: "no_token",
  });
}

/**
 * A token that writes to `owner`'s repositories: an installation token of the company's GitHub
 * App (minted from `appJwt`) when its keys are stored and it is installed on `owner`, else the
 * stored `GITHUB_TOKEN`; `prefer: "token"` tries `GITHUB_TOKEN` first. A `DriverError` with
 * `vendorCode` `no_token` when there is neither.
 */
export async function githubToken(
  secrets: RemoteContext["secrets"],
  owner: string,
  prefer: "app" | "token" = "app",
): Promise<string> {
  return (await mint(secrets, owner, prefer)).token;
}

const Pull = z.object({
  number: z.number(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

/** A pull request as GitHub answers it, as a change follows it: merged once `merged_at` is set. */
const pullOf = (pull: z.infer<typeof Pull>): PullRequest => ({
  number: pull.number,
  url: pull.html_url,
  branch: pull.head.ref,
  head: pull.head.sha,
  state: pull.merged_at ? "merged" : pull.state,
  ...(pull.merged_at && pull.merge_commit_sha && { mergeSha: pull.merge_commit_sha }),
});

const Rule = z.object({
  type: z.string(),
  parameters: z
    .object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() })
    .loose()
    .optional(),
});

/**
 * The repository `repo` on GitHub, signed in as `githubToken` says. The token is kept for the calls
 * made together and after them, an installation token until five minutes before its hour is out and
 * a person's for five minutes, so a token or an installation set later is used soon after.
 */
function openRepo(repo: RepoRef, { secrets }: RemoteContext): SourceHost {
  const base = repoPath(repo.owner, repo.name);
  let kept: Promise<Minted> | undefined;
  let until = 0;
  const token = async (prefer?: "app" | "token") => {
    if (prefer !== undefined) return (await mint(secrets, repo.owner, prefer, repo.name)).token;
    if (kept && Date.now() >= until) kept = undefined;
    if (!kept) {
      kept = mint(secrets, repo.owner, "app", repo.name);
      until = Infinity;
    }
    const minted = await kept.catch((err: unknown) => {
      kept = undefined;
      throw err;
    });
    // An installation token until five minutes before its hour is out; a person's for five minutes.
    until = Math.min(until, (minted.expiresAt ?? Date.now() + 600_000) - 300_000);
    return minted.token;
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const reply = await send(await token(), method, `${base}${path}`, body);
    // A token revoked or rotated since it was kept: the next call takes a fresh one.
    if (reply.status === 401) kept = undefined;
    return reply;
  };
  const okCall = async <T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    codes: Record<number, string> = {},
  ) => {
    const reply = await call(method, path, body);
    if (reply.status >= 300) throw failed(method, `${base}${path}`, reply, codes[reply.status]);
    return read(schema, reply.body, `${method} ${base}${path}`);
  };

  const host: SourceHost = {
    token,
    async pullRequestFor(branch) {
      const query = new URLSearchParams({ state: "all", head: `${repo.owner}:${branch}` });
      const pulls = await okCall("GET", `/pulls?${query}`, z.array(Pull));
      const pull = pulls.find((p) => p.state === "open") ?? pulls[0];
      return pull && pullOf(pull);
    },
    async pullRequest(number) {
      return pullOf(await okCall("GET", `/pulls/${number}`, Pull));
    },
    async openPullRequest({ branch, base: into, title, body }) {
      const path = "/pulls";
      const reply = await call("POST", path, { title, head: branch, base: into, body });
      if (reply.status < 300) return pullOf(read(Pull, reply.body, `POST ${base}${path}`));
      // Opened already (by an earlier try of the same step): that one, when it is into the same base.
      const exists = JSON.stringify(reply.body?.errors ?? "").includes("A pull request already exists");
      if (reply.status === 422 && exists) {
        const query = new URLSearchParams({ state: "open", head: `${repo.owner}:${branch}`, base: into });
        const [open] = await okCall("GET", `/pulls?${query}`, z.array(Pull));
        if (open) return pullOf(open);
      }
      throw failed("POST", `${base}${path}`, reply);
    },
    async mergePullRequest(number, { sha, method, title }) {
      const body = { sha, merge_method: method, ...(title && { commit_title: title }) };
      // 409: the branch moved on from `sha`; 405: GitHub will not merge it (a conflict, a rule).
      const codes = { 409: "head_moved", 405: "not_mergeable" };
      try {
        return { sha: (await okCall("PUT", `/pulls/${number}/merge`, z.object({ sha: z.string() }), body, codes)).sha };
      } catch (err) {
        // A retry after a merge whose answer was lost: GitHub refuses it, but the pull request is merged.
        if (!(err instanceof DriverError) || err.vendorCode === undefined) throw err;
        const pull = await host.pullRequest(number);
        if (pull.state === "merged" && pull.mergeSha) return { sha: pull.mergeSha };
        throw err;
      }
    },
    async closePullRequest(number) {
      await okCall("PATCH", `/pulls/${number}`, Pull, { state: "closed" });
    },
    async deleteBranch(branch) {
      const path = `/git/refs/heads/${branchPath(branch)}`;
      const reply = await call("DELETE", path);
      // GitHub answers a branch that is gone with 422, "Reference does not exist".
      if (reply.status < 300 || (reply.status === 422 && /does not exist/i.test(reply.body?.message ?? ""))) return;
      throw failed("DELETE", `${base}${path}`, reply);
    },
    async setStatus({ sha, state, description, targetUrl }) {
      await okCall("POST", `/statuses/${sha}`, z.object({ id: z.number() }), {
        state,
        context: CONTEXT,
        // GitHub refuses a description longer than 140 characters.
        description: [...description].length > 140 ? `${[...description].slice(0, 139).join("")}…` : description,
        ...(targetUrl && { target_url: targetUrl }),
      });
    },
    async enforcement(branch): Promise<HostEnforcement> {
      const path = `/rules/branches/${branchPath(branch)}`;
      const reply = await call("GET", path);
      // GitHub refuses to read rules where the plan has none: "Upgrade to GitHub Pro or make this repository public".
      const unplanned = reply.status === 403 && !limited(reply) && /upgrade|public/i.test(reply.body?.message ?? "");
      if (unplanned) return { pullRequest: false, check: false, reason: NO_RULES };
      if (reply.status >= 300) throw failed("GET", `${base}${path}`, reply);
      const rules = read(z.array(Rule), reply.body, `GET ${base}${path}`);
      return {
        pullRequest: rules.some((rule) => rule.type === "pull_request"),
        check: rules.some(
          (rule) =>
            rule.type === "required_status_checks" &&
            !!rule.parameters?.required_status_checks?.some((c) => c.context === CONTEXT),
        ),
      };
    },
  };
  return host;
}

const Repository = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const Push = z.object({ ref: z.string(), after: z.string(), deleted: z.boolean().optional(), repository: Repository });
const PullEvent = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    merged: z.boolean().nullish(),
    merge_commit_sha: z.string().nullish(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullish() }),
  }),
  repository: Repository.extend({ full_name: z.string() }),
});

const repoOf = ({ name, owner }: z.infer<typeof Repository>): RepoRef => ({ owner: owner.login, name });

/** What a delivery of `event` says, for the events a change follows: a branch pushed, a pull request closed. */
function eventsOf(event: string | null, payload: unknown): RemoteEvent[] {
  if (event === "push") {
    const push = read(Push, payload, "a push webhook");
    if (push.deleted || !push.ref.startsWith("refs/heads/")) return [];
    return [
      { kind: "pushed", repo: repoOf(push.repository), branch: push.ref.slice("refs/heads/".length), head: push.after },
    ];
  }
  if (event === "pull_request") {
    const pull = read(PullEvent, payload, "a pull_request webhook");
    // A fork's branch is not the repository's own, though it may share a name.
    if (pull.action !== "closed" || pull.pull_request.head.repo?.full_name !== pull.repository.full_name) return [];
    const merged = pull.pull_request.merged === true;
    const sha = merged ? pull.pull_request.merge_commit_sha : undefined;
    return [
      {
        kind: "closed",
        repo: repoOf(pull.repository),
        branch: pull.pull_request.head.ref,
        number: pull.number,
        merged,
        ...(sha && { sha }),
      },
    ];
  }
  return [];
}

/** Whether `signature` (`X-Hub-Signature-256`) is `body`'s HMAC SHA-256 under `secret`, compared in constant time. */
function signedBy(secret: string, body: Buffer, signature: string | null): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A clone URL of a repository on GitHub: `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` or `ssh://git@github.com/o/r(.git)`. */
const GITHUB_URL =
  /^(?:https:\/\/(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/**
 * GitHub's remote half: `matches` a GitHub clone URL, `open`s a repository (its pull requests,
 * the `sanoma` status, the rules on a branch), verifies and reads the App's webhooks, and lists
 * the accounts the App is installed on.
 */
export const githubRemote: RemoteHalf = {
  matches(url) {
    const match = GITHUB_URL.exec(url.trim());
    return match ? { owner: match[1]!, name: match[2]! } : undefined;
  },
  open: openRepo,
  async webhook(request, { secrets }) {
    const secret = (await secrets([GITHUB_APP_SECRETS.webhook_secret])).get(GITHUB_APP_SECRETS.webhook_secret);
    if (!secret) {
      throw new DriverError(
        `github: ${GITHUB_APP_SECRETS.webhook_secret} is not stored, so no webhook can be verified`,
        {
          retryable: false,
          vendorCode: "no_webhook_secret",
        },
      );
    }
    const raw = Buffer.from(await request.arrayBuffer());
    if (!signedBy(secret, raw, request.headers.get("x-hub-signature-256"))) {
      throw new DriverError("github: the webhook's signature is missing or wrong", {
        retryable: false,
        status: 401,
        vendorCode: "bad_signature",
      });
    }
    // An App delivers JSON; a repository's own webhook may send it form-encoded, as `payload`.
    const body = raw.toString("utf8");
    const form = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded");
    const json = form ? new URLSearchParams(body).get("payload") : body;
    let payload: unknown;
    try {
      payload = JSON.parse(json ?? "");
    } catch {
      throw new DriverError("github: the webhook's body is not JSON", { retryable: false, vendorCode: "bad_payload" });
    }
    return eventsOf(request.headers.get("x-github-event"), payload);
  },
  async owners({ secrets }) {
    const jwt = jwtOf(await secrets([GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem]));
    return (jwt ? await installations(jwt) : []).map(({ account }) => ({
      login: account.login,
      kind: account.type === "Organization" ? ("organization" as const) : ("user" as const),
    }));
  },
  async permissions({ secrets }) {
    const jwt = jwtOf(await secrets([GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem]));
    return jwt ? (await ok(jwt, "GET", "/app", App)).permissions : undefined;
  },
};
