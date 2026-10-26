import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { remoteFor, resolveConfig } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { github } from "../src/index.ts";
import { appJwt, GITHUB_APP_SECRETS, githubRemote, githubToken } from "../src/remote.ts";

// GitHub's remote half over replayed replies. The reads (`remote-*.json`) are GitHub's own
// answers, for Sanoma-AI/sanoma (public, a ruleset requiring a pull request) and sanoma-ops (private,
// on Free). The writes are hand-written in the shape GitHub answers, for a repository that does not
// exist, so no live run opens, merges or comments on anything: they skip themselves live.

/** What a recording must not keep: a token GitHub minted. */
const scrub = (exchanges: Exchange[]): Exchange[] =>
  JSON.parse(JSON.stringify(exchanges).replaceAll(/"token":"[^"]*"/g, '"token":"ghs_recorded"'));

const { play, sent } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["GITHUB_TOKEN"],
  env: { GITHUB_TOKEN: "ghx_test" },
  scrub,
});

/** Secrets that are exactly `values`, read when asked. */
const only = (values: Record<string, string | undefined>) => ({
  secrets: async (names: readonly string[]) =>
    new Map(names.flatMap((name) => (values[name] ? [[name, values[name]] as const] : []))),
});
/** The secrets as the app reads them: here from the environment, which the replay sets. */
const fromEnv = only(process.env);

/** The App's keys: a key pair of its own, made once. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const app = { [GITHUB_APP_SECRETS.id]: "4242", [GITHUB_APP_SECRETS.pem]: pem };

/** The App's id a request's JWT is signed by, or "nobody" when the signature does not verify. */
const signer = (headers: Headers) => {
  const [head, body, signature] = headers.get("authorization")!.replace("Bearer ", "").split(".");
  const verified = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, signature!, "base64url");
  return verified ? JSON.parse(Buffer.from(body!, "base64url").toString()).iss : "nobody";
};

/** A branch head the hand-written replies name. */
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const sanoma = { owner: "Sanoma-AI", name: "sanoma" };
const acme = { owner: "acme", name: "acme-ops" };

/** A pull request of acme/acme-ops as GitHub answers it. */
const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://github.com/acme/acme-ops/pull/${number}`,
  state: "open",
  merged_at: null,
  merge_commit_sha: "f00d000000000000000000000000000000000000",
  head: { ref: "draft/hire-ada", sha: HEAD },
  base: { ref: "main" },
  ...fields,
});

/** The App's installations, on `login`. */
const installed = (login: string): Exchange => ({
  method: "GET",
  path: "/app/installations?per_page=100",
  status: 200,
  body: [{ id: 7, account: { login, type: "Organization" } }],
});

/** A merge's answer. */
const merge = (status: number, body: unknown): Exchange => ({
  method: "PUT",
  path: "/repos/acme/acme-ops/pulls/12/merge",
  status,
  body,
});

/** A branch's rules, with a pull request and a required check named `context`. */
const checks = (context: string) => [
  { type: "pull_request", parameters: {} },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context, integration_id: 123456 }],
    },
  },
];

describe("githubRemote.matches", () => {
  it("reads a repository from an HTTPS or SSH clone URL of GitHub, and no other host's", () => {
    for (const url of [
      "https://github.com/acme/acme-ops",
      "https://github.com/acme/acme-ops.git",
      "git@github.com:acme/acme-ops.git",
      "git@github.com:acme/acme-ops",
    ]) {
      expect(githubRemote.matches(url), url).toEqual(acme);
    }
    expect(githubRemote.matches("https://github.com/acme/site.v2.git")).toEqual({ owner: "acme", name: "site.v2" });
    for (const url of ["https://gitlab.com/acme/acme-ops.git", "https://github.com/acme", "file:///tmp/acme-ops"]) {
      expect(githubRemote.matches(url), url).toBeUndefined();
    }
  });

  it("is the connector's remote half, which remoteFor finds by URL", () => {
    const { remotes } = resolveConfig({
      workflows: [],
      connectors: [github],
      databaseUrl: "postgresql://localhost:5433/not_opened",
    });
    expect(remotes.get("github")).toBe(githubRemote);
    expect(remoteFor(remotes, "git@github.com:acme/acme-ops.git")).toEqual({
      vendor: "github",
      remote: githubRemote,
      repo: acme,
    });
    expect(remoteFor(remotes, "https://gitlab.com/acme/acme-ops.git")).toBeUndefined();
  });
});

describe("githubToken", () => {
  const minted: Exchange = {
    method: "POST",
    path: "/app/installations/7/access_tokens",
    status: 201,
    body: { token: "ghs_minted", expires_at: "2099-01-01T00:00:00Z" },
  };

  it("signs a JWT as the App, good for nine minutes", () => {
    const [, body] = appJwt("4242", pem).split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(claims.iss).toBe("4242");
    expect(claims.exp - claims.iat).toBe(600);
  });

  it.skipIf(live)("mints an installation token of the App installed on the owner, signed as the App", async () => {
    play("app-token", [installed("acme"), minted]);
    const secrets = only({ ...app, GITHUB_TOKEN: "ghp_person" }).secrets;
    expect(await githubToken(secrets, "ACME")).toBe("ghs_minted");
    expect(sent.map((s) => signer(s.headers))).toEqual(["4242", "4242"]);
  });

  it.skipIf(live)("takes GITHUB_TOKEN when the App is installed elsewhere, or first when preferred", async () => {
    play("app-elsewhere", [installed("someone-else")]);
    const secrets = only({ ...app, GITHUB_TOKEN: "ghp_person" }).secrets;
    expect(await githubToken(secrets, "acme")).toBe("ghp_person");
    expect(await githubToken(secrets, "acme", "token")).toBe("ghp_person");
    expect(sent).toHaveLength(1);
  });

  it.skipIf(live)("takes the App when GITHUB_TOKEN is preferred but not stored", async () => {
    play("app-token", [installed("acme"), minted]);
    expect(await githubToken(only(app).secrets, "acme", "token")).toBe("ghs_minted");
  });

  it("takes GITHUB_TOKEN with no request when the App's keys are not stored, and fails with neither", async () => {
    play("none", []);
    expect(await githubToken(fromEnv.secrets, "acme")).toBe("ghx_test");
    await expect(githubToken(only({}).secrets, "acme")).rejects.toMatchObject({
      retryable: false,
      vendorCode: "no_token",
      message: "github: no GITHUB_TOKEN, and the GitHub App is not installed on acme",
    });
  });

  it.skipIf(live)("takes GITHUB_TOKEN when the App's keys do not work, and fails without it", async () => {
    const refused: Exchange = {
      method: "GET",
      path: "/app/installations?per_page=100",
      status: 401,
      body: { message: "A JSON web token could not be decoded" },
    };
    play("app-refused", [refused, refused]);
    expect(await githubToken(only({ ...app, GITHUB_TOKEN: "ghp_person" }).secrets, "acme")).toBe("ghp_person");
    await expect(githubToken(only(app).secrets, "acme")).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(
      githubToken(only({ [GITHUB_APP_SECRETS.id]: "4242", [GITHUB_APP_SECRETS.pem]: "not a key" }).secrets, "acme"),
    ).rejects.toMatchObject({ code: "driver_failed", message: "github: signing as the GitHub App failed" });
  });

  it.skipIf(live)("mints once for a repository opened, for calls made together and while the token lasts", async () => {
    play("app-token-kept", [
      installed("acme"),
      minted,
      { method: "GET", path: "/repos/acme/acme-ops/pulls/12", status: 200, body: pull(12) },
      { method: "GET", path: "/repos/acme/acme-ops/pulls/12", status: 200, body: pull(12) },
    ]);
    const host = githubRemote.open(acme, only(app));
    await Promise.all([host.pullRequest(12), host.pullRequest(12)]);
    expect(sent.slice(2).map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer ghs_minted",
      "Bearer ghs_minted",
    ]);
  });
});

describe("a repository opened", () => {
  it("reads a merged pull request, by number and by branch", async () => {
    play("remote-pull-request");
    const host = githubRemote.open(sanoma, fromEnv);
    const merged = {
      number: 354,
      url: "https://github.com/Sanoma-AI/sanoma/pull/354",
      branch: "task/348-cloudflare",
      head: "d0f4599f343d75d878e5a1648a4a0ea607655c28",
      state: "merged",
      mergeSha: "c0d01228f40b81ba18af0d9367d5ca54449a307e",
    };
    expect(await host.pullRequest(354)).toEqual(merged);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer ghx_test");
    expect(sent[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(sent[0]!.headers.get("accept")).toBe("application/vnd.github+json");
    play("remote-pull-request-for");
    expect(await host.pullRequestFor("task/348-cloudflare")).toEqual(merged);
  });

  it("says a branch with no pull request has none", async () => {
    play("remote-pull-request-none");
    expect(await githubRemote.open(sanoma, fromEnv).pullRequestFor("draft/nothing")).toBeUndefined();
  });

  it.skipIf(live)("takes a branch's open pull request over an older closed one", async () => {
    play("pulls", [
      {
        method: "GET",
        path: "/repos/acme/acme-ops/pulls?state=all&head=acme:draft/hire-ada",
        status: 200,
        body: [pull(13, { state: "closed" }), pull(12)],
      },
    ]);
    expect(await githubRemote.open(acme, fromEnv).pullRequestFor("draft/hire-ada")).toMatchObject({
      number: 12,
      state: "open",
    });
  });

  it.skipIf(live)("opens a pull request, and answers with the open one when the branch has one already", async () => {
    const host = githubRemote.open(acme, fromEnv);
    const request = { branch: "draft/hire-ada", base: "main", title: "Hire Ada", body: "Adds Ada." };
    play("open", [{ method: "POST", path: "/repos/acme/acme-ops/pulls", status: 201, body: pull(12) }]);
    expect(await host.openPullRequest(request)).toEqual({
      number: 12,
      url: "https://github.com/acme/acme-ops/pull/12",
      branch: "draft/hire-ada",
      head: HEAD,
      state: "open",
    });
    expect(sent[0]!.body).toEqual({ title: "Hire Ada", head: "draft/hire-ada", base: "main", body: "Adds Ada." });
    play("open-again", [
      {
        method: "POST",
        path: "/repos/acme/acme-ops/pulls",
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "A pull request already exists for acme:draft/hire-ada.",
            },
          ],
        },
      },
      {
        method: "GET",
        path: "/repos/acme/acme-ops/pulls?state=open&head=acme:draft/hire-ada&base=main",
        status: 200,
        body: [pull(12)],
      },
    ]);
    expect(await host.openPullRequest(request)).toMatchObject({ number: 12, state: "open" });
  });

  it.skipIf(live)("squash-merges at the head it was given, and names a moved head and a refused merge", async () => {
    const host = githubRemote.open(acme, fromEnv);
    const sha = HEAD;
    play("merge", [
      merge(200, {
        sha: "beef000000000000000000000000000000000000",
        merged: true,
        message: "Pull Request successfully merged",
      }),
    ]);
    expect(await host.mergePullRequest(12, { sha, method: "squash", title: "Hire Ada (#12)" })).toEqual({
      sha: "beef000000000000000000000000000000000000",
    });
    expect(sent[0]!.body).toEqual({ sha, merge_method: "squash", commit_title: "Hire Ada (#12)" });
    play("merge-moved", [merge(409, { message: "Head branch was modified. Review and try the merge again." })]);
    await expect(host.mergePullRequest(12, { sha, method: "squash" })).rejects.toMatchObject({
      code: "driver_failed",
      vendorCode: "head_moved",
      status: 409,
      retryable: false,
    });
    play("merge-refused", [merge(405, { message: "Pull Request is not mergeable" })]);
    await expect(host.mergePullRequest(12, { sha, method: "squash" })).rejects.toMatchObject({
      vendorCode: "not_mergeable",
      status: 405,
      retryable: false,
      message: "github: PUT /repos/acme/acme-ops/pulls/12/merge answered 405: Pull Request is not mergeable",
    });
  });

  it.skipIf(live)("closes a pull request, and deletes a branch, gone already or not", async () => {
    const host = githubRemote.open(acme, fromEnv);
    play("close", [
      { method: "PATCH", path: "/repos/acme/acme-ops/pulls/12", status: 200, body: pull(12, { state: "closed" }) },
      { method: "DELETE", path: "/repos/acme/acme-ops/git/refs/heads/draft/hire-ada", status: 204, body: null },
      {
        method: "DELETE",
        path: "/repos/acme/acme-ops/git/refs/heads/draft/hire-ada",
        status: 422,
        body: { message: "Reference does not exist" },
      },
    ]);
    await host.closePullRequest(12);
    expect(sent[0]!.body).toEqual({ state: "closed" });
    await host.deleteBranch!("draft/hire-ada");
    await host.deleteBranch!("draft/hire-ada");
  });

  it.skipIf(live)("sets the sanoma status on a commit, its description cut to GitHub's 140 characters", async () => {
    const sha = HEAD;
    play("status", [
      { method: "POST", path: `/repos/acme/acme-ops/statuses/${sha}`, status: 201, body: { id: 1, state: "pending" } },
      { method: "POST", path: `/repos/acme/acme-ops/statuses/${sha}`, status: 201, body: { id: 2, state: "failure" } },
    ]);
    const host = githubRemote.open(acme, fromEnv);
    await host.setStatus({
      sha,
      state: "pending",
      description: "Waiting for admin",
      targetUrl: "https://ops.acme.test/changes/hire-ada",
    });
    await host.setStatus({ sha, state: "failure", description: "x".repeat(200) });
    expect(sent[0]!.body).toEqual({
      state: "pending",
      context: "sanoma",
      description: "Waiting for admin",
      target_url: "https://ops.acme.test/changes/hire-ada",
    });
    expect(sent[1]!.body).toMatchObject({ state: "failure", context: "sanoma" });
    expect(sent[1]!.body.description).toHaveLength(140);
    expect(sent[1]!.body).not.toHaveProperty("target_url");
  });

  it("reads what a ruleset enforces on a branch", async () => {
    play("remote-rules");
    expect(await githubRemote.open(sanoma, fromEnv).enforcement("main")).toEqual({ pullRequest: true, check: false });
  });

  it.skipIf(live)("sees a required sanoma check, and no other check", async () => {
    const host = githubRemote.open(acme, fromEnv);
    const path = "/repos/acme/acme-ops/rules/branches/main";
    play("checks", [
      { method: "GET", path, status: 200, body: checks("sanoma") },
      { method: "GET", path, status: 200, body: checks("ci") },
    ]);
    expect(await host.enforcement("main")).toEqual({ pullRequest: true, check: true });
    expect(await host.enforcement("main")).toEqual({ pullRequest: true, check: false });
  });

  it("says a private repository on Free enforces nothing, and why", async () => {
    play("remote-rules-free-private");
    expect(await githubRemote.open({ owner: "Sanoma-AI", name: "sanoma-ops" }, fromEnv).enforcement("main")).toEqual({
      pullRequest: false,
      check: false,
      reason: "On a private repository this needs GitHub Team or Pro, or a public repository.",
    });
  });

  it.skipIf(live)("fails on a 403 that is not the plan's", async () => {
    play("rules-forbidden", [
      {
        method: "GET",
        path: "/repos/acme/acme-ops/rules/branches/main",
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
    ]);
    await expect(githubRemote.open(acme, fromEnv).enforcement("main")).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
  });

  it.skipIf(live)("is retryable when GitHub fails or limits, and not when it refuses", async () => {
    const host = githubRemote.open(acme, fromEnv);
    const path = "/repos/acme/acme-ops/pulls/12";
    play("faults", [
      { method: "GET", path, status: 502, body: { message: "Server Error" } },
      { method: "GET", path, status: 403, headers: { "retry-after": "60" }, body: { message: "secondary rate limit" } },
      { method: "GET", path, status: 404, body: { message: "Not Found" } },
    ]);
    await expect(host.pullRequest(12)).rejects.toMatchObject({ retryable: true, status: 502 });
    await expect(host.pullRequest(12)).rejects.toMatchObject({ retryable: true, status: 403 });
    await expect(host.pullRequest(12)).rejects.toMatchObject({
      retryable: false,
      status: 404,
      message: "github: GET /repos/acme/acme-ops/pulls/12 answered 404: Not Found",
    });
  });
});

describe("githubRemote.webhook", () => {
  const secret = "whsec-test";
  const stored = only({ [GITHUB_APP_SECRETS.webhook_secret]: secret });
  const repository = { name: "acme-ops", full_name: "acme/acme-ops", owner: { login: "acme", name: "acme" } };
  const delivery = (event: string, payload: unknown, sign: string | null = secret, type = "application/json") => {
    const body =
      type === "application/json"
        ? JSON.stringify(payload)
        : new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const headers = new Headers({ "content-type": type, "x-github-event": event });
    if (sign) headers.set("x-hub-signature-256", `sha256=${createHmac("sha256", sign).update(body).digest("hex")}`);
    return new Request("https://ops.acme.test/webhooks/github", { method: "POST", headers, body });
  };
  const hook = (request: Request) => githubRemote.webhook!(request, stored);
  const push = (ref: string, fields: Record<string, unknown> = {}) => ({
    ref,
    before: "0".repeat(40),
    after: HEAD,
    deleted: false,
    repository,
    ...fields,
  });
  const closed = (merged: boolean) => ({
    action: "closed",
    number: 12,
    pull_request: {
      number: 12,
      merged,
      merge_commit_sha: "beef000000000000000000000000000000000000",
      head: {
        ref: "draft/hire-ada",
        sha: HEAD,
        repo: { full_name: "acme/acme-ops" },
      },
    },
    repository,
  });

  it("maps a push to a branch, and leaves out a tag or a deleted branch", async () => {
    expect(await hook(delivery("push", push("refs/heads/main")))).toEqual([
      { kind: "pushed", repo: acme, branch: "main", head: HEAD },
    ]);
    expect(
      await hook(delivery("push", push("refs/heads/draft/hire-ada"), secret, "application/x-www-form-urlencoded")),
    ).toMatchObject([{ branch: "draft/hire-ada" }]);
    expect(await hook(delivery("push", push("refs/tags/v1")))).toEqual([]);
    expect(await hook(delivery("push", push("refs/heads/old", { deleted: true })))).toEqual([]);
  });

  it("maps a closed pull request, merged with its commit or not, and leaves out other actions, a fork's and other events", async () => {
    expect(await hook(delivery("pull_request", closed(true)))).toEqual([
      {
        kind: "closed",
        repo: acme,
        branch: "draft/hire-ada",
        number: 12,
        merged: true,
        sha: "beef000000000000000000000000000000000000",
      },
    ]);
    expect(await hook(delivery("pull_request", closed(false)))).toEqual([
      { kind: "closed", repo: acme, branch: "draft/hire-ada", number: 12, merged: false },
    ]);
    expect(await hook(delivery("pull_request", { ...closed(false), action: "opened" }))).toEqual([]);
    const fork = closed(true);
    fork.pull_request.head.repo = { full_name: "someone/acme-ops" };
    expect(await hook(delivery("pull_request", fork))).toEqual([]);
    expect(await hook(delivery("ping", { zen: "Keep it logically awesome." }))).toEqual([]);
  });

  it("refuses a delivery with a bad or missing signature, and any without the secret stored", async () => {
    const refused = { retryable: false, status: 401, vendorCode: "bad_signature" };
    await expect(hook(delivery("push", push("refs/heads/main"), "another-secret"))).rejects.toMatchObject(refused);
    await expect(hook(delivery("push", push("refs/heads/main"), null))).rejects.toMatchObject(refused);
    await expect(githubRemote.webhook!(delivery("push", push("refs/heads/main")), only({}))).rejects.toMatchObject({
      vendorCode: "no_webhook_secret",
    });
  });
});

describe("githubRemote.owners", () => {
  it.skipIf(live)("lists the accounts the App is installed on, and none without its keys", async () => {
    play("owners", [
      {
        method: "GET",
        path: "/app/installations?per_page=100",
        status: 200,
        body: [
          { id: 7, account: { login: "acme", type: "Organization" } },
          { id: 8, account: { login: "ada", type: "User" } },
        ],
      },
    ]);
    expect(await githubRemote.owners!(only(app))).toEqual([
      { login: "acme", kind: "organization" },
      { login: "ada", kind: "user" },
    ]);
    expect(await githubRemote.owners!(only({}))).toEqual([]);
  });
});
