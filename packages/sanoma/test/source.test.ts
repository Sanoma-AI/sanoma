import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
