import { live, replay } from "@sanoma-ai/testing/replay";
import { type Driver, memorySecrets } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { githubDriver } from "../src/driver.ts";
import { FAKE_TEMPLATE, fakeGithub } from "../src/fake.ts";
import { github } from "../src/index.ts";
import { GITHUB_APP_SECRETS } from "../src/rest.ts";
import { app, scrub, signer } from "./app-keys.ts";

// The operations through the App over replayed replies (`fixtures/app-*.json`), hand-written in the
// shape GitHub answers until the App is recorded live: they make repositories, commits and keys, so
// they skip themselves live.

const { play, sent } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: [GITHUB_APP_SECRETS.id, GITHUB_APP_SECRETS.pem],
  env: {},
  scrub,
});

let seq = 0;
/** Calls one of a driver's operations the way the runtime does, its input parsed by the operation's schema. */
const call = (driver: Driver, op: string, input: unknown, secrets: Record<string, string> = app): Promise<any> => {
  const [resource, name] = op.split(".") as [string, string];
  const spec = (github as unknown as Record<string, Record<string, { input: { parse(v: unknown): unknown } }>>)[
    resource
  ]![name]!;
  return driver.ops[op]!(spec.input.parse(input), {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `github.${op}`,
    attempt: 1,
    secrets: memorySecrets(secrets),
  });
};

const generate = {
  installation: 7,
  template: { owner: "Sanoma-AI", repository: "company-template" },
  owner: "acme",
  name: "acme-ops",
  description: "acme's company",
};
const files = { "sanoma.config.ts": "export default {};\n" };
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

/** The authorization each request after the token's minting carried. */
const bearers = () => sent.slice(1).map((s) => s.headers.get("authorization"));

describe("the operations through the App", () => {
  it.skipIf(live)("reads an installation with the App's JWT", async () => {
    play("app-installation");
    const found = await call(githubDriver(), "installation.get", { id: 7 });
    expect(github.installation.get.output.parse(found)).toEqual({
      id: 7,
      account: { login: "acme", id: 1, type: "Organization" },
      repositorySelection: "selected",
    });
    expect(sent.map((s) => signer(s.headers))).toEqual(["4242"]);
  });

  it.skipIf(live)("generates a private repository from a template on an installation token", async () => {
    play("app-generate");
    const made = await call(githubDriver(), "repository.generate", generate);
    expect(github.repository.generate.output.parse(made)).toEqual({
      id: 1296269,
      fullName: "acme/acme-ops",
      cloneUrl: "https://github.com/acme/acme-ops.git",
      sshUrl: "git@github.com:acme/acme-ops.git",
      defaultBranch: "main",
    });
    expect(signer(sent[0]!.headers)).toBe("4242");
    // Minted for the installation, not one repository: the new one is not there yet.
    expect(sent[0]!.body).toBeNull();
    expect(sent[1]!.body).toEqual({
      owner: "acme",
      name: "acme-ops",
      private: true,
      include_all_branches: false,
      description: "acme's company",
    });
    expect(bearers()).toEqual(["Bearer ghs_recorded"]);
    // The token is never returned.
    expect(JSON.stringify(made)).not.toContain("ghs_");
  });

  it.skipIf(live)("fails with GitHub's message when the App may not generate there", async () => {
    play("app-generate-forbidden");
    await expect(call(githubDriver(), "repository.generate", generate)).rejects.toMatchObject({
      code: "driver_failed",
      status: 403,
      retryable: false,
      message:
        "github: POST /repos/Sanoma-AI/company-template/generate answered 403: Resource not accessible by integration",
    });
  });

  it.skipIf(live)(
    "fails with what failed validation on a 422, when the repository there is not the template's",
    async () => {
      play("app-generate-taken");
      await expect(call(githubDriver(), "repository.generate", generate)).rejects.toMatchObject({
        status: 422,
        retryable: false,
        message:
          "github: POST /repos/Sanoma-AI/company-template/generate answered 422: Validation Failed: name already exists on this account",
      });
    },
  );

  it.skipIf(live)(
    "answers the repository an earlier try made from the template, when its answer was lost",
    async () => {
      play("app-generate-retried");
      expect(await call(githubDriver(), "repository.generate", generate)).toMatchObject({ fullName: "acme/acme-ops" });
    },
  );

  it.skipIf(live)("reads the commit a branch is at, on a token for that repository alone", async () => {
    play("app-head");
    const input = { installation: 7, repository: "acme/acme-ops", branch: "main" };
    expect(await call(githubDriver(), "repository.head", input)).toEqual({
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    });
    expect(sent[0]!.body).toEqual({ repositories: ["acme-ops"] });
    expect(bearers()).toEqual(["Bearer ghs_recorded"]);
  });

  it.skipIf(live)("tries a branch's head again while the repository is empty, as one just generated is", async () => {
    play("app-head-empty");
    const input = { installation: 7, repository: "acme/acme-ops", branch: "main" };
    await expect(call(githubDriver(), "repository.head", input)).rejects.toMatchObject({
      status: 409,
      retryable: true,
    });
  });

  it.skipIf(live)("commits files on top of a branch, its head and tree read in one call", async () => {
    play("app-commit");
    const input = { installation: 7, repository: "acme/acme-ops", branch: "main", message: "Set up acme", files };
    expect(await call(githubDriver(), "repository.commit", input)).toEqual({
      sha: "7638417db6d59f3c431d3e1f261cc637155684cd",
    });
    // Minted for this repository alone.
    expect(sent[0]!.body).toEqual({ repositories: ["acme-ops"] });
    expect(sent[2]!.body).toEqual({
      base_tree: "9fb037999f264ba9a7fc6274d15fa3ae2ab98312",
      tree: [{ path: "sanoma.config.ts", mode: "100644", type: "blob", content: files["sanoma.config.ts"] }],
    });
    expect(sent[3]!.body).toEqual({
      message: "Set up acme",
      tree: "cd8274d15fa3ae2ab983129fb037999f264ba9a7",
      parents: ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"],
    });
    expect(sent[4]!.body).toEqual({ sha: "7638417db6d59f3c431d3e1f261cc637155684cd" });
    expect(new Set(bearers())).toEqual(new Set(["Bearer ghs_recorded"]));
  });

  it.skipIf(live)("makes no second commit when the head is the commit an earlier try made", async () => {
    play("app-commit-retried");
    const input = { installation: 7, repository: "acme/acme-ops", branch: "main", message: "Set up acme", files };
    expect(await call(githubDriver(), "repository.commit", input)).toEqual({
      sha: "7638417db6d59f3c431d3e1f261cc637155684cd",
    });
  });

  it.skipIf(live)(
    "starts a branch not there yet from the default branch, waiting for a new repository to fill",
    async () => {
      play("app-commit-new-branch");
      const input = {
        installation: 7,
        repository: "acme/acme-ops",
        branch: "setup/acme",
        message: "Set up acme",
        files,
      };
      expect(await call(githubDriver(), "repository.commit", input)).toEqual({
        sha: "7638417db6d59f3c431d3e1f261cc637155684cd",
      });
      expect(sent.at(-1)!.body).toEqual({
        ref: "refs/heads/setup/acme",
        sha: "7638417db6d59f3c431d3e1f261cc637155684cd",
      });
    },
  );

  it.skipIf(live)("adds a read-only deploy key", async () => {
    play("app-deploy-key");
    const input = { installation: 7, repository: "acme/acme-ops", title: "acme host", key: KEY };
    expect(await call(githubDriver(), "repository.addDeployKey", input)).toEqual({ id: 1234 });
    expect(sent[0]!.body).toEqual({ repositories: ["acme-ops"] });
    expect(sent[1]!.body).toEqual({ title: "acme host", key: KEY, read_only: true });
  });

  it.skipIf(live)("answers the key an earlier try added, which GitHub keeps without its comment", async () => {
    play("app-deploy-key-retried");
    const input = { installation: 7, repository: "acme/acme-ops", title: "acme host", key: `${KEY} host@acme` };
    expect(await call(githubDriver(), "repository.addDeployKey", input)).toEqual({ id: 1234 });
  });

  it("fails, not retryable, without the App's keys, and calls nothing", async () => {
    play("none", []);
    await expect(call(githubDriver(), "installation.get", { id: 7 }, {})).rejects.toMatchObject({
      retryable: false,
      vendorCode: "no_app",
      message: "github: SANOMA_GITHUB_APP_ID and SANOMA_GITHUB_APP_PEM are not stored",
    });
    await expect(
      call(githubDriver(), "installation.get", { id: 7 }, { ...app, [GITHUB_APP_SECRETS.pem]: "not a key" }),
    ).rejects.toMatchObject({ code: "driver_failed", message: "github: signing as the GitHub App failed" });
    expect(sent).toEqual([]);
  });

  it("refuses a repository not written <owner>/<name>, or a name that is a path's own", () => {
    for (const repository of ["acme-ops", "acme/..", "../keys", "acme/."]) {
      expect(() => github.repository.commit.input.parse({ ...generate, repository }), repository).toThrow(
        "a repository as <owner>/<name>",
      );
    }
    expect(() => github.repository.generate.input.parse({ ...generate, name: ".." })).toThrow("a GitHub name");
  });
});

describe("fakeGithubApp", () => {
  it("generates from its template, commits on a branch or a new one, and adds a key", async () => {
    const fake = fakeGithub();
    expect(await call(fake.driver, "installation.get", { id: 7 })).toEqual({
      id: 7,
      account: { login: "acme", id: 7, type: "User" },
      repositorySelection: "all",
    });
    const made = await call(fake.driver, "repository.generate", generate);
    expect(made).toEqual({
      id: 2,
      fullName: "acme/acme-ops",
      cloneUrl: "https://github.com/acme/acme-ops.git",
      sshUrl: "git@github.com:acme/acme-ops.git",
      defaultBranch: "main",
    });
    const commit = { installation: 7, repository: "acme/acme-ops", branch: "main", message: "Set up", files };
    expect((await call(fake.driver, "repository.commit", commit)).sha).toMatch(/^[0-9a-f]{40}$/);
    await call(fake.driver, "repository.commit", { ...commit, branch: "setup" });
    const repo = fake.app.state.repositories["acme/acme-ops"]!;
    expect(fake.app.state.repositories[FAKE_TEMPLATE]!.branches.main!.files).toEqual({ "README.md": "# Company\n" });
    expect(repo.private).toBe(true);
    expect(repo.branches.setup!.files).toEqual({ ...repo.branches.main!.files });
    expect(repo.branches.main!.files).toMatchObject({ "README.md": "# Company\n", ...files });
    const key = { installation: 7, repository: "acme/acme-ops", title: "host", key: KEY };
    expect(await call(fake.driver, "repository.addDeployKey", key)).toEqual({ id: 3 });
    expect(repo.keys).toEqual([{ id: 3, title: "host", key: KEY, readOnly: true }]);
    expect(fake.calls.map((c) => c.op)).toEqual([
      "github.installation.get",
      "github.repository.generate",
      "github.repository.commit",
      "github.repository.commit",
      "github.repository.addDeployKey",
    ]);
  });

  it("reads a branch's head, and answers 404 for a branch not there", async () => {
    const fake = fakeGithub();
    await call(fake.driver, "repository.generate", generate);
    const head = { installation: 7, repository: "acme/acme-ops", branch: "main" };
    const { sha } = await call(fake.driver, "repository.commit", { ...head, message: "Set up", files });
    expect(await call(fake.driver, "repository.head", head)).toEqual({ sha });
    await expect(call(fake.driver, "repository.head", { ...head, branch: "nope" })).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
    await expect(
      call(fake.driver, "repository.head", { ...head, repository: "Sanoma-AI/company-template" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("makes the same SHA for the same parent, message and files", async () => {
    const commit = { installation: 7, repository: "acme/acme-ops", branch: "main", message: "Set up", files };
    const [one, two] = [fakeGithub(), fakeGithub()];
    for (const fake of [one, two]) await call(fake.driver, "repository.generate", generate);
    expect(await call(one.driver, "repository.commit", commit)).toEqual(
      await call(two.driver, "repository.commit", commit),
    );
  });

  it("answers as GitHub does: an installation not there, another account, a name taken, a key in use", async () => {
    const fake = fakeGithub();
    await expect(call(fake.driver, "installation.get", { id: 8 })).rejects.toMatchObject({ status: 404 });
    // Beside the personal account acme's 7, an organization's.
    expect(await call(fake.driver, "installation.get", { id: 9 })).toEqual({
      id: 9,
      account: { login: "acme-inc", id: 9, type: "Organization" },
      repositorySelection: "all",
    });
    await expect(call(fake.driver, "repository.generate", { ...generate, owner: "other" })).rejects.toMatchObject({
      status: 403,
      message:
        "github: POST /repos/Sanoma-AI/company-template/generate answered 403: Resource not accessible by integration",
    });
    await call(fake.driver, "repository.generate", generate);
    await expect(call(fake.driver, "repository.generate", generate)).rejects.toMatchObject({
      status: 422,
      message:
        "github: POST /repos/Sanoma-AI/company-template/generate answered 422: Validation Failed: name already exists on this account",
    });
    const key = { installation: 7, repository: "acme/acme-ops", title: "host", key: KEY };
    await call(fake.driver, "repository.addDeployKey", key);
    await expect(call(fake.driver, "repository.addDeployKey", key)).rejects.toMatchObject({ status: 422 });
    // Once across all of GitHub, as GitHub takes a key.
    await call(fake.driver, "repository.generate", { ...generate, name: "acme-site" });
    await expect(
      call(fake.driver, "repository.addDeployKey", { ...key, repository: "acme/acme-site" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      call(fake.driver, "repository.addDeployKey", { ...key, repository: "Sanoma-AI/company-template" }),
    ).rejects.toMatchObject({ status: 404 });
    fake.failNext("github.repository.commit");
    await expect(
      call(fake.driver, "repository.commit", {
        installation: 7,
        repository: "acme/acme-ops",
        branch: "main",
        message: "m",
        files,
      }),
    ).rejects.toMatchObject({ retryable: true });
    fake.reset();
    expect(fake.app.state.repositories["acme/acme-ops"]).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});
