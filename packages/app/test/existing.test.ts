import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "@sanoma-ai/connector-github";
import { fakeGithub } from "@sanoma-ai/connector-github/fake";
import { supabase } from "@sanoma-ai/connector-supabase";
import { fakeSupabase } from "@sanoma-ai/connector-supabase/fake";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { allowAll, resolveConfig, withSetup } from "@sanoma-ai/workflows";
import { describeConfig, LOCKFILE, readLockfile } from "@sanoma-ai/workflows/describe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { localGitSource } from "../../sanoma/src/source.ts";
import { ApiError, INFRA } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { CONNECT_BRANCH, connectExisting } from "../src/server/setup.ts";

// Connecting an existing repository or database (/setup/existing) in a git repository of its
// own, with and without a remote, on the GitHub and Supabase fakes: the file rendered from what
// each import read, where it is committed, and the apply that only binds. Needs Postgres and the
// built app, as app.test.ts does.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "sanoma-existing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gh = fakeGithub();
const sb = fakeSupabase();
const source = localGitSource(root);
const config = {
  workflows: [],
  connectors: [withSetup(github, { driver: () => gh.driver }), withSetup(supabase, { driver: () => sb.driver })],
  policy: allowAll,
  root,
};
const test = useTestApp(config, { databaseUrl: testDatabaseUrl("existing"), source });
const alice = { id: "alice" };
const context = (): AppContext => ({
  resolved: resolveConfig(test.config),
  description: describeConfig(test.config),
  client: test.client,
  login: loopbackLogin(),
  source,
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
/** The fake's recorded repository and project, as GitHub and Supabase name them. */
const REPO = "sanoma";
const REF = "sanomatestprojectref";
const id = { repo: `${INFRA}#repo`, store: `${INFRA}#store` };

// A fresh repository on main, with one commit and nothing declared.
beforeEach(() => {
  for (const name of [".git", "resources", "README.md"]) rmSync(join(root, name), { recursive: true, force: true });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(root, "README.md"), "acme\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "Start");
  gh.reset();
  sb.reset();
});

/** What connecting answers when it refuses. */
const refused = (request: { repository?: string; project?: string }) =>
  connectExisting(context(), alice, request).catch((err: unknown) => err);

/** Connects, then waits for the apply it started. */
async function connect(request: { repository?: string; project?: string }) {
  const done = await connectExisting(context(), alice, request);
  return { done, report: await test.client.applyReport(done.runId) };
}

describe("connecting an existing repository and database", () => {
  it("in a repository without a remote: declares both as read, commits, and binds them without creating", async () => {
    const { done, report } = await connect({ repository: REPO, project: REF });
    const text = readFileSync(join(root, INFRA), "utf8");
    expect(done).toMatchObject({ file: INFRA, text, revision: expect.any(String) });
    expect(done.branch).toBeUndefined();
    expect(text).toMatchInlineSnapshot(`
      "// The database password is declared as a generated secret, since Supabase never reads it back.
      // Binding the project changes nothing; the next apply that changes it sets a new password.
      import { github } from "@sanoma-ai/connector-github/resources";
      import { supabase } from "@sanoma-ai/connector-supabase/resources";
      import { secret } from "sanoma/resources";

      export const repo = github.repository({
        name: "sanoma",
        description:
          "Open core: schema, planner, Cedar policies, ledger format, MCP server, local studio, CLI, first-party connectors, modules",
        visibility: "public",
      });

      export const store = supabase.project({
        name: "sanoma-test",
        organization_id: "sanoma-test-org",
        region: "us-east-1",
        database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
      });

      export default [repo, store];
      "
    `);

    // Every step a bind, of the object given, and nothing created.
    expect(report.plan.problems).toEqual([]);
    expect(report.plan.steps.map((s) => [s.id, s.action, "source" in s && s.source])).toEqual([
      [id.repo, "bind", "given"],
      [id.store, "bind", "given"],
    ]);
    expect(report.results.every((r) => r.status === "done")).toBe(true);
    const bindings = report.lockfile.bindings;
    expect(bindings[id.store]).toEqual({ type: "supabase.project", id: REF });
    expect(bindings[id.repo]).toEqual({ type: "github.repository", id: expect.stringMatching(/^R_/) });
    expect(readLockfile(root).bindings).toEqual(bindings);

    // On main: the file, then each binding, committed as they were made.
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("log", "--format=%s", "-3").split("\n")).toEqual([
      `Apply: bind ${id.store} (supabase.project ${REF})`,
      `Apply: bind ${id.repo} (github.repository ${bindings[id.repo]!.id})`,
      `Connect github ${REPO} and supabase ${REF}`,
    ]);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("in a repository with a remote: commits on a branch of its own for a person to merge, the lockfile too", async () => {
    git("remote", "add", "origin", "https://github.com/acme/ops.git");
    const { done, report } = await connect({ repository: REPO });
    expect(done.branch).toBe(CONNECT_BRANCH);
    expect(done.diff).toContain(`+++ b/${INFRA}`);
    expect(done.diff).toContain("+export const repo = github.repository({");
    expect(done.text).not.toContain("supabase");
    expect(report.plan.steps.map((s) => s.action)).toEqual(["bind"]);

    expect(git("branch", "--show-current")).toBe(CONNECT_BRANCH);
    expect(git("log", "--format=%s", "main..HEAD").split("\n")).toEqual([
      `Apply: bind ${id.repo} (github.repository ${report.lockfile.bindings[id.repo]!.id})`,
      `Connect github ${REPO}`,
    ]);
    // main is as it was: nothing lands there until the branch is merged.
    expect(git("log", "--format=%s", "main")).toBe("Start");
    expect(git("ls-tree", "-r", "--name-only", "main")).toBe("README.md");
  });

  it("refuses a file already there, a branch already there, an owner the connector does not read, and nothing found", async () => {
    expect(await refused({ repository: "someone-else/sanoma" })).toMatchObject({
      status: 400,
      message: expect.stringContaining("not someone-else/sanoma: set GITHUB_OWNER to someone-else"),
    });
    expect(await refused({ project: "sanomamissingproject" })).toMatchObject({
      status: 400,
      message: "There is no supabase.project sanomamissingproject to connect",
    });
    git("remote", "add", "origin", "https://github.com/acme/ops.git");
    // A commit that fails leaves the checkout as it was: no file, back on main, no branch.
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await refused({ project: REF })).toMatchObject({
      status: 500,
      message: expect.stringContaining(`Could not commit ${INFRA}`),
    });
    expect(existsSync(join(root, INFRA))).toBe(false);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("branch", "--list", CONNECT_BRANCH)).toBe("");
    rmSync(join(root, ".git/hooks/pre-commit"));
    git("branch", CONNECT_BRANCH);
    expect(await refused({ project: REF })).toMatchObject({
      status: 409,
      message: expect.stringContaining(`Could not start the branch ${CONNECT_BRANCH}`),
    });
    mkdirSync(join(root, "resources/sanoma"), { recursive: true });
    writeFileSync(join(root, INFRA), "export default [];\n");
    const there = await refused({ project: REF });
    expect(there).toBeInstanceOf(ApiError);
    expect(there).toMatchObject({ status: 409 });
    // Nothing written, committed or started by any of them.
    expect(existsSync(join(root, LOCKFILE))).toBe(false);
    expect(git("log", "--format=%s", "--all")).toBe("Start");
  });
});

describe("the page", () => {
  let app: App;
  afterAll(() => app?.close());

  it("takes a repository and a project's ref, and the connect page links to it", async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    app = await startApp(test.config, { port: 0, source });
    const page = await (await fetch(new URL("/setup/existing", app.url))).text();
    expect(page).toContain("Connect an existing repository or database");
    expect(page).toContain('placeholder="owner/name"');
    expect(page).toContain('placeholder="project ref"');
    const connectPage = await (await fetch(new URL("/setup/connect", app.url))).text();
    expect(connectPage).toContain('href="/setup/existing"');
  });
});
