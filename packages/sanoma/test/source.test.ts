import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
