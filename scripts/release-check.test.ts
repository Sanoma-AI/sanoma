import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIdentity } from "../packages/sanoma/test/git.ts";
import { changedSince, type Manifest, type OnNpm, releaseCheck } from "./release-check.ts";

/** A package.json for the fixture's package `a`, its `version` line followed by more, as in the workspace. */
const manifest = (version: string, fields: object = {}) =>
  JSON.stringify({ name: "a", version, scripts: { prepack: "node ../tools/download.ts" }, ...fields }, null, 2);
const workspace = (name: string, version: string): Manifest => ({ name, version, path: `/${name}` });
const npm = (entries: [string, OnNpm][]) => new Map(entries);

describe("changedSince", () => {
  let root: string;
  let pkg: Manifest;
  const identity = gitIdentity();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "-A");
    git("commit", "-qm", Object.keys(files).join(" "));
    return git("rev-parse", "--short", "HEAD");
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "release-check-"));
    git("init", "-q", "--initial-branch=main");
    pkg = { name: "a", version: "0.1.0", path: join(root, "packages/a") };
    commit({ "packages/a/package.json": manifest("0.1.0"), "packages/a/src/index.ts": "1" });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names commits to the package's source since its version was set", () => {
    const dev = commit({
      "packages/a/test/index.test.ts": "test",
      "packages/a/src/AGENTS.md": "notes",
      "packages/a/package.json": manifest("0.1.0", { devDependencies: { msw: "^2" } }),
      "packages/b/src/x.ts": "b",
    });
    expect(changedSince(pkg, root)).toEqual([]);
    const source = commit({ "packages/a/src/index.ts": "2" });
    const download = commit({ "packages/tools/download.ts": "v2" });
    const dependency = commit({
      "packages/a/package.json": manifest("0.1.0", { dependencies: { zod: "^4" } }),
    });
    // Once more than its devDependencies differs, every commit to its package.json counts.
    expect(changedSince(pkg, root)).toEqual([dependency, download, source, dev]);
    commit({ "packages/a/package.json": manifest("0.1.1") });
    expect(changedSince(pkg, root)).toEqual([]);
  });

  it("counts from the commit that made the package public", () => {
    commit({ "packages/a/package.json": manifest("0.1.0", { private: true }) });
    commit({ "packages/a/src/index.ts": "2" });
    commit({ "packages/a/package.json": manifest("0.1.0") });
    expect(changedSince(pkg, root)).toEqual([]);
  });

  it("ignores side-branch history already included in a squash release, but still detects later changes", () => {
    git("checkout", "-qb", "feature");
    commit({ "packages/a/src/index.ts": "2" });
    git("checkout", "-q", "main");
    git("merge", "--squash", "feature");
    git("commit", "-qm", "Squash feature");
    commit({ "packages/a/package.json": manifest("0.1.1") });
    git("checkout", "-q", "feature");
    git("merge", "--no-ff", "-qm", "Integrate release", "main");
    expect(changedSince(pkg, root)).toEqual([]);
    const next = commit({ "packages/a/src/index.ts": "3" });
    expect(changedSince(pkg, root)).toContain(next);
  });

  it("ignores source edits that were fully reverted before release", () => {
    commit({ "packages/a/src/index.ts": "2" });
    commit({ "packages/a/src/index.ts": "1" });
    expect(changedSince(pkg, root)).toEqual([]);
  });
});

describe("releaseCheck", () => {
  const runtime = workspace("@sanoma-ai/workflows", "0.7.1");
  const launcher = workspace("sanoma", "0.7.1");
  const published = { ...launcher, dependencies: { "@sanoma-ai/workflows": "0.7.1" } };

  it("names a package npm does not have, and lists every version to publish", () => {
    const neon = workspace("@sanoma-ai/connector-neon", "0.1.0");
    const result = releaseCheck(
      [runtime, neon],
      npm([
        [runtime.name, "new version"],
        [neon.name, "new package"],
      ]),
      () => [],
    );
    expect(result.publish).toEqual(["@sanoma-ai/workflows@0.7.1", "@sanoma-ai/connector-neon@0.1.0"]);
    expect(result.problems).toEqual([
      '@sanoma-ai/connector-neon is not on npm: publish it once by hand and set its trusted publisher (README "Release")',
    ]);
  });

  it("names a public version whose source changed, and the packages that pin it", () => {
    const result = releaseCheck(
      [runtime, launcher],
      npm([
        [runtime.name, runtime],
        [launcher.name, published],
      ]),
      (p) => (p === runtime ? ["a1", "b2", "c3", "d4", "e5"] : []),
    );
    expect(result.publish).toEqual([]);
    expect(result.problems).toEqual([
      "@sanoma-ai/workflows@0.7.1 is on npm, but a1, b2, c3 and 2 more changed its source since: give it a new version",
      "sanoma@0.7.1 takes @sanoma-ai/workflows 0.7.1, not 0.7.2: give it a new version too",
    ]);
  });

  it("passes when every public version matches its source", () => {
    const result = releaseCheck(
      [runtime, launcher],
      npm([
        [runtime.name, runtime],
        [launcher.name, published],
      ]),
      () => [],
    );
    expect(result).toEqual({ problems: [], publish: [] });
  });
});
