import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../src/source.ts";
import { copyFixture, FIXTURE_GRID, ensureBuilt } from "./fixture.ts";
import { gitIdentity } from "./git.ts";

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(() => {
  gitIdentity(vi.stubEnv);
  dir = mkdtempSync(join(tmpdir(), "sanoma-source-"));
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "# acme\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "First");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("localGitSource", () => {
  it("commits the paths alone, on the current branch, as made by the author through Sanoma", async () => {
    const source = localGitSource(dir);
    writeFileSync(join(dir, "infra.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "other.ts"), "export const b = 2;\n");
    git("add", "other.ts");

    const committed = await source.commit({ paths: ["infra.ts"], message: "Adopt a", author: "alice" });
    expect(committed?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(await source.head()).toBe(committed!.revision);
    expect(git("log", "-1", "--format=%an|%s|%D")).toBe("alice via Sanoma|Adopt a|HEAD -> main");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("infra.ts");
    // What was staged besides stays staged, uncommitted.
    expect(git("status", "--porcelain")).toBe("A  other.ts");
    expect(source.root).toBe(dir);
  });

  it("commits nothing, and says so, when the paths hold no change", async () => {
    const source = localGitSource(dir);
    const before = await source.head();
    expect(await source.commit({ paths: ["README.md"], message: "Nothing", author: "alice" })).toBeUndefined();
    expect(await source.head()).toBe(before);
    // No paths is no change, whatever is staged.
    writeFileSync(join(dir, "other.ts"), "export const b = 2;\n");
    git("add", "other.ts");
    expect(await source.commit({ paths: [], message: "Nothing", author: "alice" })).toBeUndefined();
    expect(await source.head()).toBe(before);
  });

  it("reads the commit a ref names, and refuses one that names none", async () => {
    const source = localGitSource(dir);
    expect(await source.head("main")).toBe(git("rev-parse", "HEAD"));
    await expect(source.head("nope")).rejects.toThrow(/nope/);
  });

  it("pushes a branch, history and all, to a repository by its URL, keeping the token out of every trace", async () => {
    const source = localGitSource(dir);
    const remote = join(dir, "..", `${dir.split("/").at(-1)}-remote.git`);
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
    try {
      const url = pathToFileURL(remote).href;
      const token = "ghs_secret-token-value";
      await source.push!({ url, token, ref: "main" });
      const pushed = execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();
      expect(pushed).toBe(await source.head());
      expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(token);

      const failed = source.push!({ url: `${url}-missing`, token, ref: "main" });
      await expect(failed).rejects.toThrow(/^git push to file:.*-missing failed: /);
      await expect(failed).rejects.not.toThrow(token);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});

describe("localGitSource and the repository it was cloned from", () => {
  let origin = "";
  let url = "";
  beforeEach(() => {
    origin = `${dir}-origin.git`;
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    url = pathToFileURL(origin).href;
  });
  afterEach(() => rmSync(origin, { recursive: true, force: true }));

  /** `origin` added and `main` pushed to it, as a clone has them. */
  const cloned = () => {
    git("remote", "add", "origin", url);
    git("push", "--quiet", "origin", "main");
  };

  /** A commit on the remote's `main` from another clone, as a merge there makes one: its revision. */
  const mergedThere = (file: string) => {
    const other = `${dir}-other`;
    const there = (...args: string[]) => execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();
    execFileSync("git", ["clone", "--quiet", url, other]);
    try {
      writeFileSync(join(other, file), `export const ${file.replace(/\W/g, "")} = 1;\n`);
      there("add", file);
      there("commit", "--quiet", "-m", `Merge ${file}`);
      there("push", "--quiet", "origin", "main");
      return there("rev-parse", "HEAD");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  };

  it("reads the remote's URL, and none without one", async () => {
    const source = localGitSource(dir);
    expect(await source.remoteUrl!()).toBeUndefined();
    cloned();
    expect(await source.remoteUrl!()).toBe(url);
  });

  it("follows the remote's main: a fast-forward, keeping the token out of every trace", async () => {
    cloned();
    const source = localGitSource(dir);
    const merged = mergedThere("merged.ts");
    const token = "ghs_secret-token-value";
    expect(await source.follow!({ url, token, ref: "main" })).toEqual({ revision: merged });
    expect(await source.head()).toBe(merged);
    expect(readFileSync(join(dir, "merged.ts"), "utf8")).toContain("merged");
    expect(git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(token);
    // Again with nothing new: the same revision.
    expect(await source.follow!({ url, token, ref: "main" })).toEqual({ revision: merged });

    const failed = source.follow!({ url: `${url}-missing`, token, ref: "main" });
    await expect(failed).rejects.toThrow(/^git fetch from file:.*-missing failed: /);
    await expect(failed).rejects.not.toThrow(token);
  });

  it("skips following when the checkout has uncommitted changes, another branch is checked out, or main has its own commits", async () => {
    cloned();
    const source = localGitSource(dir);
    const before = await source.head();
    mergedThere("merged.ts");
    const target = { url, token: "t", ref: "main" };

    writeFileSync(join(dir, "README.md"), "# acme, edited\n");
    expect(await source.follow!(target)).toEqual({ skipped: "the checkout has uncommitted changes" });
    git("checkout", "--quiet", "README.md");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    expect(await source.follow!(target)).toEqual({ skipped: "the checkout has uncommitted changes" });
    rmSync(join(dir, "new.ts"));

    git("checkout", "--quiet", "-b", "other");
    expect(await source.follow!(target)).toEqual({ skipped: "other is checked out, not main" });
    git("checkout", "--quiet", "--detach");
    expect(await source.follow!(target)).toEqual({ skipped: "no branch is checked out, not main" });
    git("checkout", "--quiet", "main");
    expect(await source.head()).toBe(before);

    // A commit of its own here (the app's Adopt commits on the checked-out branch): no fast-forward.
    writeFileSync(join(dir, "local.ts"), "export const l = 1;\n");
    const local = await source.commit({ paths: ["local.ts"], message: "Local", author: "alice" });
    expect(await source.follow!(target)).toEqual({ skipped: `main has commits ${url} does not` });
    expect(await source.head()).toBe(local!.revision);
  });

  it("follows a draft's branch in the draft's checkout: the host's commits on it, the live checkout left alone", async () => {
    writeFileSync(join(dir, ".gitignore"), ".sanoma/\n");
    git("add", ".gitignore");
    git("commit", "--quiet", "-m", "Ignore");
    cloned();
    const source = localGitSource(dir);
    const live = await source.head();
    const draft = await source.draft!("x");
    const token = "ghs_secret-token-value";
    await source.push!({ url, token, ref: draft.branch });
    // Someone pushes to the draft's branch on the host.
    const other = `${dir}-other`;
    const there = (...args: string[]) => execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();
    execFileSync("git", ["clone", "--quiet", "--branch", draft.branch, url, other]);
    try {
      writeFileSync(join(other, "pushed.ts"), "export const p = 1;\n");
      there("add", "pushed.ts");
      there("commit", "--quiet", "-m", "Pushed on the host");
      there("push", "--quiet", "origin", draft.branch);
      const pushed = there("rev-parse", "HEAD");

      const target = { url, token, ref: draft.branch };
      expect(await source.follow!(target)).toEqual({ revision: pushed });
      expect(await source.head(draft.branch)).toBe(pushed);
      expect(readFileSync(join(draft.root, "pushed.ts"), "utf8")).toContain("p = 1");
      expect(await source.head()).toBe(live);
      expect(existsSync(join(dir, "pushed.ts"))).toBe(false);

      // A commit of the draft's own that the host lacks: no fast-forward.
      writeFileSync(join(draft.root, "mine.ts"), "export const m = 1;\n");
      await draft.commit({ paths: ["mine.ts"], message: "Mine", author: "alice" });
      expect(await source.follow!(target)).toEqual({ skipped: `${draft.branch} has commits ${url} does not` });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

const status = () => git("status", "--porcelain", "--ignored=no");

describe("localGitSource's drafts", () => {
  beforeEach(() => {
    // As the template ignores them: `node_modules/` names a directory, and a draft's is a link.
    writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
    mkdirSync(join(dir, "node_modules", "sanoma"), { recursive: true });
    git("add", ".gitignore");
    git("commit", "--quiet", "-m", "Ignore");
  });

  it("opens a draft as a worktree on its own branch, commits and diffs there, and leaves the live checkout alone", async () => {
    const source = localGitSource(dir);
    const live = await source.head();
    const draft = await source.draft!("laptop-step");
    expect(draft).toMatchObject({ branch: "draft/laptop-step", root: join(dir, ".sanoma", "drafts", "laptop-step") });
    expect(git("-C", draft.root, "branch", "--show-current")).toBe("draft/laptop-step");
    expect(await source.head(draft.branch)).toBe(live);
    // The root's install, linked by a relative path, and ignored in the draft as in the root.
    expect(readlinkSync(join(draft.root, "node_modules"))).toBe("../../../node_modules");
    expect(realpathSync(join(draft.root, "node_modules"))).toBe(realpathSync(join(dir, "node_modules")));
    expect(git("-C", draft.root, "status", "--porcelain")).toBe("");
    expect(await source.drafts!()).toEqual(["laptop-step"]);

    mkdirSync(join(draft.root, "workflows"));
    writeFileSync(join(draft.root, "workflows", "offboard.ts"), "export const laptop = 1;\n");
    writeFileSync(join(draft.root, "README.md"), "# acme\n\nOffboarding returns the laptop.\n");
    const change = { paths: ["workflows/offboard.ts", "README.md"], message: "Add a laptop step", author: "agent" };
    const committed = await draft.commit(change);
    expect(committed?.revision).toBe(await source.head(draft.branch));
    expect(git("log", "-1", "--format=%an|%s", draft.branch)).toBe("agent via Sanoma|Add a laptop step");
    expect(await source.diff!("laptop-step")).toEqual({
      files: ["README.md", "workflows/offboard.ts"],
      summary: expect.stringMatching(
        /README\.md +\| 2 \+\+\n.*workflows\/offboard\.ts +\| 1 \+\n 2 files changed, 3 insertions\(\+\)$/s,
      ),
    });
    // Opened again: the same draft, edits and all, and git's exclude file named the link once.
    expect(await source.draft!("laptop-step")).toMatchObject({ branch: draft.branch, root: draft.root });
    expect(await source.head(draft.branch)).toBe(committed!.revision);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8").match(/^\/node_modules$/gm)).toHaveLength(1);

    // The live checkout: the same commit, branch and files, and nothing to commit.
    expect(await source.head()).toBe(live);
    expect(git("branch", "--show-current")).toBe("main");
    expect(existsSync(join(dir, "workflows"))).toBe(false);
    expect(status()).toBe("");
  });

  it("keeps two drafts open at once, each on its own branch, and commits to one twice at once", async () => {
    const source = localGitSource(dir);
    const [a, b] = await Promise.all([source.draft!("a"), source.draft!("b"), source.draft!("a")]);
    for (const name of ["a1", "a2"]) writeFileSync(join(a.root, `${name}.ts`), `export const ${name} = 1;\n`);
    writeFileSync(join(b.root, "b.ts"), "export const b = 1;\n");
    await Promise.all([
      a.commit({ paths: ["a1.ts"], message: "A1", author: "agent" }),
      a.commit({ paths: ["a2.ts"], message: "A2", author: "agent" }),
      b.commit({ paths: ["b.ts"], message: "B", author: "agent" }),
    ]);
    expect(await source.drafts!()).toEqual(["a", "b"]);
    expect((await source.diff!("a")).files).toEqual(["a1.ts", "a2.ts"]);
    expect((await source.diff!("b")).files).toEqual(["b.ts"]);
    expect(status()).toBe("");
  });

  it("diffs a moved file as its old path and its new one", async () => {
    writeFileSync(join(dir, "old.ts"), "export const moved = 1;\n");
    git("add", "old.ts");
    git("commit", "--quiet", "-m", "Old");
    const source = localGitSource(dir);
    const draft = await source.draft!("move");
    renameSync(join(draft.root, "old.ts"), join(draft.root, "new.ts"));
    await draft.commit({ paths: ["old.ts", "new.ts"], message: "Move", author: "agent" });
    expect(await source.diff!("move")).toMatchObject({
      files: ["new.ts", "old.ts"],
      summary: expect.stringMatching(/2 files changed/),
    });
    expect(status()).toBe("");
  });

  it("opens a draft whose directory was deleted again from its branch, leaving other missing worktrees listed", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("x");
    writeFileSync(join(draft.root, "x.ts"), "export const x = 1;\n");
    await draft.commit({ paths: ["x.ts"], message: "X", author: "agent" });
    const other = `${dir}-other`;
    git("worktree", "add", "--quiet", "-b", "other", other);
    // What `git clean -X` does to a draft, and an unmounted disk to the other.
    rmSync(join(dir, ".sanoma"), { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    expect(await source.drafts!()).toEqual([]);
    // A diff reads the branch alone.
    expect((await source.diff!("x")).files).toEqual(["x.ts"]);

    expect(await source.draft!("x")).toMatchObject({ root: draft.root });
    expect(readFileSync(join(draft.root, "x.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(existsSync(join(draft.root, "node_modules"))).toBe(true);
    expect(await source.drafts!()).toEqual(["x"]);
    expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${realpathSync(dir)}-other`);
  });

  it("refuses an id that is not a name, and a repository that does not ignore .sanoma/", async () => {
    const source = localGitSource(dir);
    for (const id of ["../escape", "a/b", "..", ".", "", "a b", "x".repeat(65), "-/../../x"]) {
      await expect(source.draft!(id), id).rejects.toThrow(/A draft's id is letters, digits, _ and -/);
      await expect(source.diff!(id), id).rejects.toThrow(/A draft's id/);
    }
    expect(existsSync(join(dir, ".sanoma"))).toBe(false);

    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    await expect(source.draft!("ok")).rejects.toThrow(/\.sanoma\/ is not in .*\.gitignore/);
    expect(git("branch", "--list", "draft/*")).toBe("");
  });

  it("closes a draft: its checkout and its branch gone, whatever it held, and nothing for one closed already", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("done");
    writeFileSync(join(draft.root, "done.ts"), "export const done = 1;\n");
    await draft.commit({ paths: ["done.ts"], message: "Done", author: "agent" });
    writeFileSync(join(draft.root, "uncommitted.ts"), "export const u = 1;\n");
    const other = await source.draft!("other");

    await source.closeDraft!("done");
    expect(existsSync(draft.root)).toBe(false);
    expect(git("branch", "--list", "--format=%(refname:short)", "draft/*")).toBe("draft/other");
    expect(await source.drafts!()).toEqual(["other"]);
    await source.closeDraft!("done");

    // One whose directory is gone (`git clean -X`) still listed, its branch kept: both go.
    rmSync(other.root, { recursive: true, force: true });
    await source.closeDraft!("other");
    expect(git("branch", "--list", "draft/*")).toBe("");
    expect(git("worktree", "list", "--porcelain")).not.toContain("drafts");
    expect(status()).toBe("");
    await expect(source.closeDraft!("../escape")).rejects.toThrow(/A draft's id/);
  });

  it("pushes a draft by its branch", async () => {
    const source = localGitSource(dir);
    const draft = await source.draft!("p");
    writeFileSync(join(draft.root, "p.ts"), "export const p = 1;\n");
    await draft.commit({ paths: ["p.ts"], message: "P", author: "agent" });
    const remote = `${dir}-remote.git`;
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    try {
      await source.push!({ url: pathToFileURL(remote).href, token: "t", ref: draft.branch });
      const pushed = execFileSync("git", ["rev-parse", draft.branch], { cwd: remote, encoding: "utf8" }).trim();
      expect(pushed).toBe(await source.head(draft.branch));
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});

/**
 * A source repository in a directory of its own, with `files` at their paths, in one commit on
 * `main`: what `commit` adds later is another commit there. Its `apps/<app>/app.ts` names its URL.
 */
function sourceRepo(files: Record<string, string>) {
  const at = mkdtempSync(join(tmpdir(), "sanoma-app-source-"));
  const url = pathToFileURL(at).href;
  const there = (...args: string[]) => execFileSync("git", args, { cwd: at, encoding: "utf8" }).trim();
  const commit = (changed: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(changed)) {
      mkdirSync(join(at, path, ".."), { recursive: true });
      writeFileSync(join(at, path), text.replaceAll("<url>", url));
    }
    there("add", "--all");
    there("commit", "--quiet", "-m", message);
    return there("rev-parse", "HEAD");
  };
  there("init", "--quiet", "--initial-branch=main");
  commit(files, "The source");
  return { at, url, commit };
}

/** An app's `app.ts`, naming the source's URL (`<url>`, filled in when written). */
const APP_TS = 'import { defineApp } from "sanoma";\n\nexport default defineApp({ source: "<url>" });\n';

/** The draft's branch merged into main as a person merges it (a merge, not a squash), and the draft closed. */
const mergeDraft = async (repo: ReturnType<typeof localGitSource>, id: string) => {
  git("merge", "--quiet", "--ff-only", `draft/${id}`);
  await repo.closeDraft!(id);
};

describe("localGitSource's apps", () => {
  const sources: string[] = [];
  beforeEach(() => {
    // The sources here are directories on this machine: a source is https unless the environment says otherwise.
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
    writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
    writeFileSync(join(dir, "package.json"), '{ "name": "acme" }\n');
    git("add", "--all");
    git("commit", "--quiet", "-m", "Acme");
  });
  afterEach(() => {
    for (const at of sources.splice(0)) rmSync(at, { recursive: true, force: true });
  });
  const source = (files: Record<string, string>) => {
    const made = sourceRepo(files);
    sources.push(made.at);
    return made;
  };
  it("takes an app with its history, the company's root kept, then merges the source's new commits, clean or with markers", async () => {
    const crm = source({
      // The starter's root: another README, a starter file and a package.json with the app's connectors.
      "README.md": "# The starter\n",
      "hello.ts": "export const hello = 1;\n",
      "package.json": '{ "name": "crm", "dependencies": { "@sanoma-ai/connector-ghost": "1" } }\n',
      "apps/crm/app.ts": APP_TS,
      "apps/crm/title.ts": 'export const title = "Follow up";\n',
      "apps/crm/old.ts": "export const old = 1;\n",
    });
    const repo = localGitSource(dir);
    const take = await repo.draft!("take");
    const at = (path: string) => readFileSync(join(take.root, path), "utf8");
    const taken = await take.take!({ url: crm.url, author: "ada" });
    expect(taken).toEqual({
      folder: "crm",
      revision: await repo.head(take.branch),
      merged: 1,
      conflicts: ["package.json"],
    });
    expect(at("apps/crm/app.ts")).toContain(crm.url);
    expect(at("apps/crm/title.ts")).toContain('"Follow up"');
    // The root stays the company's; package.json is both, with git's markers, for the agent.
    expect(at("README.md")).toBe("# acme\n");
    expect(existsSync(join(take.root, "hello.ts"))).toBe(false);
    expect(at("package.json")).toMatch(
      /^<<<<<<< HEAD\n\{ "name": "acme" \}\n\|\|\|\|\|\|\| empty tree\n=======\n.*connector-ghost.*\n>>>>>>> [0-9a-f]{40}\n$/,
    );
    const draftGit = (...args: string[]) => execFileSync("git", args, { cwd: take.root, encoding: "utf8" }).trim();
    expect(draftGit("status", "--porcelain")).toBe("");
    // One merge commit, by the person through Sanoma, whose second parent is the source's.
    expect(draftGit("log", "-1", "--format=%an|%P|%s")).toBe(
      `ada via Sanoma|${git("rev-parse", "main")} ${execFileSync("git", ["rev-parse", "HEAD"], { cwd: crm.at, encoding: "utf8" }).trim()}|Take crm from ${crm.url}`,
    );
    expect(draftGit("log", "-1", "--format=%b")).toBe("Conflicts left to resolve:\n- package.json");

    // The agent resolves package.json; the person merges the draft.
    writeFileSync(
      join(take.root, "package.json"),
      '{ "name": "acme", "dependencies": { "@sanoma-ai/connector-ghost": "1" } }\n',
    );
    await take.commit({ paths: ["package.json"], message: "Ghost for the CRM", author: "agent" });
    await mergeDraft(repo, "take");
    expect(await repo.behind!("crm")).toBe(0);

    // The company deletes one of the app's files.
    git("rm", "--quiet", "apps/crm/old.ts");
    git("commit", "--quiet", "-m", "No old");

    // A commit on the source: behind by one, then merged clean, and nothing more to merge after.
    // Only the app's folder: the source's root and the file the company deleted stay the company's.
    crm.commit(
      {
        "apps/crm/title.ts": 'export const title = "Follow up with a customer";\n',
        "apps/crm/old.ts": "export const old = 2;\n",
        "README.md": "# The starter, again\n",
        "workflows/demo.ts": "export const demo = 1;\n",
      },
      "Say who",
    );
    expect(await repo.behind!("crm")).toBe(1);
    const update = await repo.draft!("update");
    const updated = await update.update!({ folder: "crm", author: "ada" });
    expect(updated).toEqual({ folder: "crm", revision: await repo.head(update.branch), merged: 1, conflicts: [] });
    expect(readFileSync(join(update.root, "apps/crm/title.ts"), "utf8")).toContain("with a customer");
    expect(readFileSync(join(update.root, "README.md"), "utf8")).toBe("# acme\n");
    for (const gone of ["apps/crm/old.ts", "workflows/demo.ts"])
      expect(existsSync(join(update.root, gone))).toBe(false);
    expect(await update.update!({ folder: "crm", author: "ada" })).toEqual({ ...updated, merged: 0 });
    await mergeDraft(repo, "update");
    expect(await repo.behind!("crm")).toBe(0);
    // A commit that changes nothing an update takes (the source's root only) is not counted.
    crm.commit({ "README.md": "# The starter, a third time\n" }, "Root only");
    expect(await repo.behind!("crm")).toBe(0);

    // The company and the source both change one line: the merge commits the file with its markers.
    writeFileSync(join(dir, "apps/crm/title.ts"), 'export const title = "Follow up soon";\n');
    git("commit", "--quiet", "-am", "Soon");
    crm.commit({ "apps/crm/title.ts": 'export const title = "Follow up today";\n' }, "Today");
    const conflict = await repo.draft!("conflict");
    const conflicted = await conflict.update!({ folder: "crm", author: "ada" });
    expect(conflicted).toMatchObject({ merged: 1, conflicts: ["apps/crm/title.ts"] });
    expect(readFileSync(join(conflict.root, "apps/crm/title.ts"), "utf8")).toMatch(
      /^<<<<<<< HEAD\n.*"Follow up soon".*\n\|\|\|\|\|\|\| [0-9a-f]+\n.*"Follow up with a customer".*\n=======\n.*"Follow up today".*\n>>>>>>> [0-9a-f]{40}\n$/,
    );
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: conflict.root, encoding: "utf8" })).toBe("");
    // The live checkout never moved.
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refuses an app it cannot take or update, and leaves the draft as it was", async () => {
    const two = source({ "apps/a/app.ts": APP_TS, "apps/b/app.ts": APP_TS, "apps/b/y.ts": "export const y = 1;\n" });
    const repo = localGitSource(dir);
    const draft = await repo.draft!("refused");
    const before = await repo.head(draft.branch);
    const take = (url: string, more: { ref?: string; folder?: string } = {}) =>
      draft.take!({ url, author: "ada", ...more });
    await expect(take(two.url)).rejects.toThrow(`${two.url} holds more than one app: it holds apps/a/, apps/b/`);
    await expect(take(two.url, { folder: "c" })).rejects.toThrow(
      `${two.url} has no apps/c/: it holds apps/a/, apps/b/`,
    );
    await expect(take(two.url, { ref: "main:refs/heads/main" })).rejects.toThrow(/^Not a branch, tag or commit/);
    await expect(take(two.url, { ref: "--upload-pack=x" })).rejects.toThrow(/^Not a branch, tag or commit/);
    await expect(take(`${two.url}-missing`)).rejects.toThrow(/^git fetch from file:.*-missing failed: /);
    vi.stubEnv("GIT_ALLOW_PROTOCOL", undefined);
    await expect(take(two.url)).rejects.toThrow(/^git fetch from file:.* failed: .*transport 'file' not allowed/);
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");

    expect((await take(two.url, { folder: "a" })).conflicts).toEqual([]);
    await expect(take(two.url, { folder: "a" })).rejects.toThrow("apps/a/ is here already: update it instead");
    // Only the folder taken: the source's other app stays there, and its history is here now.
    expect(existsSync(join(draft.root, "apps/b"))).toBe(false);
    // Taken later, it comes whole, though its history is here: what changed in it since, and what did not.
    two.commit({ "apps/b/y.ts": "export const y = 2;\n", "apps/b/z.ts": "export const z = 1;\n" }, "More of b");
    expect(await take(two.url, { folder: "b" })).toMatchObject({ folder: "b", merged: 1, conflicts: [] });
    for (const file of ["app.ts", "y.ts", "z.ts"]) expect(existsSync(join(draft.root, "apps/b", file))).toBe(true);
    const empty = source({ "README.md": "# The starter\n" });
    await expect(take(empty.url)).rejects.toThrow(`${empty.url} holds no app: a source holds one apps/<name>/`);

    // The apps as main has them: a draft's app.ts is never loaded. The company's own, one never
    // taken (no shared history), and one not there.
    const onMain = (files: Record<string, string>, message: string) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git("add", "--all");
      git("commit", "--quiet", "-m", message);
    };
    onMain(
      {
        "apps/own/app.ts": 'import { defineApp } from "sanoma";\n\nexport default defineApp({});\n',
        "apps/stray/app.ts": APP_TS.replace("<url>", two.url),
        "apps/broken/app.ts": 'throw new Error("no source here");\n',
      },
      "Own apps",
    );
    const update = (folder: string) => draft.update!({ folder, author: "ada" });
    // One only in the draft waits for its take to be published.
    mkdirSync(join(draft.root, "apps/fresh"));
    writeFileSync(join(draft.root, "apps/fresh/app.ts"), APP_TS.replace("<url>", two.url));
    await expect(update("fresh")).rejects.toThrow(
      "apps/fresh/ is only in this draft: publish the take first, then update it",
    );
    await expect(update("stray")).rejects.toThrow("The draft has uncommitted changes");
    rmSync(join(draft.root, "apps/fresh"), { recursive: true, force: true });
    await expect(update("own")).rejects.toThrow("apps/own/app.ts names no source: the app is the company's own");
    await expect(update("gone")).rejects.toThrow("There is no app apps/gone/");
    // One whose app.ts does not load says why, where.
    await expect(update("broken")).rejects.toThrow("apps/broken/app.ts: no source here");
    // Its source is a's, merged above: a has history with it, stray is merely named so.
    expect((await update("stray")).merged).toBe(0);
    const other = source({ "apps/stray/app.ts": APP_TS });
    onMain({ "apps/stray/app.ts": APP_TS.replace("<url>", other.url) }, "Stray");
    await expect(update("stray")).rejects.toThrow(`apps/stray/ shares no history with ${other.url}`);
    await expect(repo.behind!("own")).rejects.toThrow("apps/own/app.ts names no source: the app is the company's own");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: draft.root, encoding: "utf8" })).toBe("");
    expect(await repo.head(draft.branch)).not.toBe(before);
  });
});

describe("localGitSource's check", () => {
  it("runs sanoma check in each draft, one at a time, with every field of its result and the live checkout untouched", async () => {
    // The fixture company in a git repository of its own: the installed bin as a child in each
    // draft, on the packages' builds (made when stale) and Postgres.
    ensureBuilt();
    rmSync(dir, { recursive: true, force: true });
    dir = copyFixture();
    writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\n");
    git("init", "--quiet", "--initial-branch=main");
    git("add", "--all");
    git("commit", "--quiet", "-m", "First");
    const source = localGitSource(dir, { databaseUrl: testDatabaseUrl("drafts") });
    const [, broken, unloadable] = await Promise.all([
      source.draft!("ok"),
      source.draft!("broken"),
      source.draft!("unloadable"),
    ]);
    writeFileSync(join(broken.root, "workflows", "broken.ts"), 'export const n: number = "one";\n');
    // Its config prints a passing result as it loads, which does not pass it: the launcher's comes last.
    const fake = JSON.stringify({ sanoma: 1, event: "checked", ok: true, problems: [], warnings: [] });
    const config = join(broken.root, "sanoma.config.ts");
    writeFileSync(config, `console.log(${JSON.stringify(fake)});\n${readFileSync(config, "utf8")}`);
    await broken.commit({ paths: ["workflows/broken.ts", "sanoma.config.ts"], message: "Break", author: "agent" });
    // A config that does not load, and says what the check's environment holds (but what macOS adds to every one).
    const names = 'Object.keys(process.env).filter((n) => !n.startsWith("__CF_")).sort().join(" ")';
    const says = `throw new Error(\`no config; env \${${names}}\`);\n`;
    writeFileSync(join(unloadable.root, "sanoma.config.ts"), says);
    await unloadable.commit({ paths: ["sanoma.config.ts"], message: "Unload", author: "agent" });
    // A credential of this process never reaches the check.
    vi.stubEnv("GHOST_ADMIN_API_KEY", "not-for-the-check");

    const [passed, failed, refused] = await Promise.all([
      source.check!("ok"),
      source.check!("broken"),
      source.check!("unloadable"),
    ]);
    // The grid comes back as the check reported it: the fixture has no policies, so all allow.
    expect(passed).toEqual({
      ok: true,
      problems: [],
      warnings: [],
      grid: FIXTURE_GRID,
    });
    expect(failed.ok).toBe(false);
    expect(failed.problems).toContainEqual(expect.stringMatching(/^workflows\/broken\.ts:1:14: .*'string'.*'number'/));
    expect(refused).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^sanoma check: .*no config; env HOME PATH SANOMA_DATABASE_URL SANOMA_EVENTS$/)],
      warnings: [],
    });
    await expect(source.check!("../escape")).rejects.toThrow(/A draft's id/);
    expect(await source.check!("never")).toEqual({
      ok: false,
      problems: [`sanoma check: the draft at ${join(dir, ".sanoma", "drafts", "never")} is not open`],
      warnings: [],
    });

    expect(await source.drafts!()).toEqual(["broken", "ok", "unloadable"]);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%s")).toBe("First");
  }, 600_000);

  it("takes an app from a source made from the starter, passing sanoma check, then updates it clean", async () => {
    // The starter's root, the fixture's with the template's includes, in the company and in the
    // source; the source adds the company-apps fixture's crm (but its site, which the check would
    // build) with an app.ts naming it, as a source's own names its repository.
    ensureBuilt();
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
    rmSync(dir, { recursive: true, force: true });
    dir = copyFixture();
    const starter = {
      ".gitignore": ".sanoma/\nnode_modules/\n",
      "tsconfig.json": readFileSync(new URL("../template/tsconfig.json", import.meta.url), "utf8"),
    };
    for (const [path, text] of Object.entries(starter)) writeFileSync(join(dir, path), text);
    git("init", "--quiet", "--initial-branch=main");
    git("add", "--all");
    git("commit", "--quiet", "-m", "First");
    const crm = sourceRepo({ ...starter, "apps/crm/app.ts": APP_TS });
    try {
      cpSync(new URL("./fixtures/project/", import.meta.url), crm.at, { recursive: true });
      cpSync(
        new URL("../../workflows/test/fixtures/company-apps/apps/crm/", import.meta.url),
        join(crm.at, "apps/crm"),
        {
          recursive: true,
          filter: (path) => !path.includes("/sites") && !path.endsWith("app.ts"),
        },
      );
      crm.commit({}, "The CRM");

      const source = localGitSource(dir, { databaseUrl: testDatabaseUrl("apps") });
      const take = await source.draft!("take");
      expect(await take.take!({ url: crm.url, author: "ada" })).toMatchObject({ folder: "crm", conflicts: [] });
      // Its scenario runs crm.follow-up, and the grid has the app's workflow.
      const checked = await source.check!("take");
      expect(checked).toMatchObject({ ok: true, problems: [] });
      expect(checked.grid?.workflows.map((w) => w.id)).toEqual(["crm.follow-up", "hello"]);

      git("merge", "--quiet", "--ff-only", take.branch);
      await source.closeDraft!("take");
      crm.commit(
        {
          "apps/crm/workflows/follow-up.ts": readFileSync(
            join(crm.at, "apps/crm/workflows/follow-up.ts"),
            "utf8",
          ).replace('"Follow up"', '"Follow up with a customer"'),
        },
        "Say who",
      );
      expect(await source.behind!("crm")).toBe(1);
      const update = await source.draft!("update");
      expect(await update.update!({ folder: "crm", author: "ada" })).toMatchObject({ merged: 1, conflicts: [] });
      expect(readFileSync(join(update.root, "apps/crm/workflows/follow-up.ts"), "utf8")).toContain("with a customer");
      expect(await source.check!("update")).toMatchObject({ ok: true, problems: [] });
    } finally {
      rmSync(crm.at, { recursive: true, force: true });
    }
  }, 600_000);
});
