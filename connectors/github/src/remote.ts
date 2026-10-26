import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import {
  DriverError,
  type HostEnforcement,
  type PullRequest,
  type RemoteContext,
  type RemoteEvent,
  type RemoteHalf,
  type RepoRef,
  retryableStatus,
  type SourceHost,
} from "@sanoma-ai/workflows";
import { z } from "zod";

// GitHub's remote half: a repository's pull requests, the `sanoma` commit status, the rules on a
// branch and the App's webhooks, over GitHub's REST API with plain `fetch`. It signs in as the
// company's GitHub App when the App is installed on the owner, else with `GITHUB_TOKEN`.

/** The secrets of the company's GitHub App the half reads, as the app's manifest flow stores them. */
export const GITHUB_APP_SECRETS = {
  id: "SANOMA_GITHUB_APP_ID",
  pem: "SANOMA_GITHUB_APP_PEM",
  webhook_secret: "SANOMA_GITHUB_WEBHOOK_SECRET",
} as const;

/** A person's token, the one the resources' driver reads too. */
const TOKEN = "GITHUB_TOKEN";

/** The commit status's name, which a ruleset's required check names. */
const CONTEXT = "sanoma";

/** What `enforcement` says when GitHub refuses to read a branch's rules (a private repository on Free). */
const NO_RULES = "On a private repository this needs GitHub Team or Pro, or a public repository.";

const API = "https://api.github.com";

const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT the GitHub App signs for itself, good for 9 minutes: what its installations are listed and its tokens minted with. */
export function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem, "base64url")}`;
}

interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

/** One call to GitHub's REST API, signed in with `token`; a failure to reach it is a retryable `DriverError`. */
async function send(token: string, method: string, path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sanoma",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new DriverError(`github: ${method} ${path}: the request failed`, { retryable: true, cause });
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** A rate limit: a 429, or a 403 with no requests left or a `retry-after` (GitHub's secondary limits). */
const limited = ({ status, headers }: Reply) =>
  status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")));

/** GitHub's answer as a `DriverError`, its message GitHub's own; retryable on a rate limit or a server error. */
function failed(method: string, path: string, reply: Reply, vendorCode?: string): DriverError {
  const message = typeof reply.body?.message === "string" ? reply.body.message : `status ${reply.status}`;
  return new DriverError(`github: ${method} ${path} answered ${reply.status}: ${message}`, {
    retryable: retryableStatus(reply.status) || limited(reply),
    status: reply.status,
    ...(vendorCode && { vendorCode }),
  });
}

/** The body of a 2xx answer, read with `schema`; anything else a `DriverError`. */
async function ok<T>(token: string, method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const reply = await send(token, method, path, body);
  if (reply.status >= 300) throw failed(method, path, reply);
  return read(schema, reply.body, `${method} ${path}`);
}

function read<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DriverError(`github: ${what} answered what Sanoma cannot read: ${z.prettifyError(parsed.error)}`, {
      retryable: false,
    });
  }
  return parsed.data;
}

const Installation = z.object({ id: z.number(), account: z.object({ login: z.string(), type: z.string() }) });
const AccessToken = z.object({ token: z.string(), expires_at: z.string() });

/** The App's installations, when its keys are among `found`; none without them. */
async function installations(found: Map<string, string>): Promise<z.infer<typeof Installation>[]> {
  const id = found.get(GITHUB_APP_SECRETS.id);
  const pem = found.get(GITHUB_APP_SECRETS.pem);
  if (!id || !pem) return [];
  return ok(appJwt(id, pem), "GET", "/app/installations", z.array(Installation));
}

/** A token, and when it stops working (an installation token's hour), as `githubToken` chooses it. */
async function mint(
  secrets: RemoteContext["secrets"],
  owner: string,
  prefer: "app" | "token",
): Promise<{ token: string; expiresAt?: number }> {
  const found = await secrets([TOKEN, GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem]);
  const token = found.get(TOKEN);
  if (prefer === "token" && token) return { token };
  const installation = (await installations(found)).find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
  if (installation) {
    const jwt = appJwt(found.get(GITHUB_APP_SECRETS.id)!, found.get(GITHUB_APP_SECRETS.pem)!);
    const made = await ok(jwt, "POST", `/app/installations/${installation.id}/access_tokens`, AccessToken);
    return { token: made.token, expiresAt: Date.parse(made.expires_at) };
  }
  if (token) return { token };
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

/** A branch name in a path, each `/`-separated part encoded. */
const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/** The repository `repo` on GitHub, signed in as `githubToken` says, the token kept while it works. */
function openRepo(repo: RepoRef, { secrets }: RemoteContext): SourceHost {
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  let kept: { token: string; until: number } | undefined;
  const token = async (prefer?: "app" | "token") => {
    if (prefer === undefined && kept && kept.until > Date.now()) return kept.token;
    const minted = await mint(secrets, repo.owner, prefer ?? "app");
    // An installation token, five minutes before its hour is out; a person's, for as long as this is open.
    if (prefer === undefined) kept = { token: minted.token, until: (minted.expiresAt ?? Infinity) - 300_000 };
    return minted.token;
  };
  const call = async (method: string, path: string, body?: unknown) =>
    send(await token(), method, `${base}${path}`, body);
  const okCall = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) =>
    ok(await token(), method, `${base}${path}`, schema, body);

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
      // Opened already (by an earlier try of the same step): that one.
      const exists = JSON.stringify(reply.body?.errors ?? "").includes("A pull request already exists");
      const open = reply.status === 422 && exists ? await host.pullRequestFor(branch) : undefined;
      if (open?.state === "open") return open;
      throw failed("POST", `${base}${path}`, reply);
    },
    async mergePullRequest(number, { sha, method, title }) {
      const path = `/pulls/${number}/merge`;
      const reply = await call("PUT", path, { sha, merge_method: method, ...(title && { commit_title: title }) });
      if (reply.status === 409) throw failed("PUT", `${base}${path}`, reply, "head_moved");
      if (reply.status === 405) throw failed("PUT", `${base}${path}`, reply, "not_mergeable");
      if (reply.status >= 300) throw failed("PUT", `${base}${path}`, reply);
      return { sha: read(z.object({ sha: z.string() }), reply.body, `PUT ${base}${path}`).sha };
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
        description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
        ...(targetUrl && { target_url: targetUrl }),
      });
    },
    async enforcement(branch): Promise<HostEnforcement> {
      const path = `/rules/branches/${branchPath(branch)}`;
      const reply = await call("GET", path);
      if (reply.status === 403 && !limited(reply)) return { pullRequest: false, check: false, reason: NO_RULES };
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
    head: z.object({ ref: z.string() }),
  }),
  repository: Repository,
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
    if (pull.action !== "closed") return [];
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
function signedBy(secret: string, body: string, signature: string | null): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A clone URL of a repository on GitHub: `https://github.com/o/r(.git)` or `git@github.com:o/r(.git)`. */
const GITHUB_URL = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

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
    const body = await request.text();
    if (!signedBy(secret, body, request.headers.get("x-hub-signature-256"))) {
      throw new DriverError("github: the webhook's signature is missing or wrong", {
        retryable: false,
        status: 401,
        vendorCode: "bad_signature",
      });
    }
    // An App delivers JSON; a repository's own webhook may send it form-encoded, as `payload`.
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
    const found = await secrets([GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem]);
    return (await installations(found)).map(({ account }) => ({
      login: account.login,
      kind: account.type === "Organization" ? ("organization" as const) : ("user" as const),
    }));
  },
};
