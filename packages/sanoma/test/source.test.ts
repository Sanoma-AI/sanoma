import { execFileSync } from "node:child_process";
import {
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
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localGitSource } from "../src/source.ts";
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
