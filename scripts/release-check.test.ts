import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIdentity } from "../packages/sanoma/test/git.ts";
import { changedSince, type Manifest, type OnNpm, releaseCheck } from "./release-check.ts";

/**
 * A package.json for the fixture's package `a`, its `version` line followed by more, as in the workspace:
 * it ships its build, a part's build and its features, and its build reads `tools/gen.ts`.
 */
const manifest = (version: string, fields: object = {}) =>
  JSON.stringify(
    {
      name: "a",
      version,
      files: ["dist", "part/dist", "features", "!part/src/*.gen.ts"],
      scripts: { build: "tsc && node tools/gen.ts", prepack: "node ../tools/download.ts" },
      ...fields,
    },
    null,
    2,
  );
const workspace = (name: string, version: string): Manifest => ({ name, version, path: `/${name}` });
/** A platform binary, published with `os`. */
const binaryAt = (name: string, version: string): Manifest => ({
  ...workspace(name, version),
  publishConfig: { os: ["linux"] },
});
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
    commit({
      "packages/a/package.json": manifest("0.1.0"),
      "packages/a/src/index.ts": "1",
      "packages/a/tools/gen.ts": "1",
      "packages/a/features/a.feature": "1",
      "packages/a/part/src/index.ts": "1",
      "packages/a/part/src/routes.gen.ts": "1",
      "packages/a/part/vite.config.ts": "1",
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names commits to the package's source since its version was set", () => {
    const dev = commit({
      "packages/a/test/index.test.ts": "test",
      "packages/a/part/test/index.test.ts": "test",
      "packages/a/tools/notes.ts": "unread",
      "packages/a/src/AGENTS.md": "notes",
      "packages/a/package.json": manifest("0.1.0", { devDependencies: { msw: "^2" } }),
      "packages/b/src/x.ts": "b",
    });
    expect(changedSince(pkg, root)).toEqual([]);
    // What it ships and what builds that: a part's source and configuration, a generated file its files
    // leave out but its build reads, a file shipped as it is, a script its build runs.
    const shippedOrBuilt = [
      "packages/a/part/src/index.ts",
      "packages/a/part/src/routes.gen.ts",
      "packages/a/part/vite.config.ts",
      "packages/a/features/a.feature",
      "packages/a/tools/gen.ts",
    ].map((path) => commit({ [path]: "2" }));
    const source = commit({ "packages/a/src/index.ts": "2" });
    const download = commit({ "packages/tools/download.ts": "v2" });
    const dependency = commit({
      "packages/a/package.json": manifest("0.1.0", { dependencies: { zod: "^4" } }),
    });
    // Once more than its devDependencies differs, every commit to its package.json counts.
    expect(changedSince(pkg, root)).toEqual([dependency, download, source, ...shippedOrBuilt.toReversed(), dev]);
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

  it("does not count a moved download script, or a comment edited in it, but counts its code", () => {
    commit({ "packages/tools/download.ts": "// in tools\nfetch(1)\n" });
    commit({ "packages/a/package.json": manifest("0.1.1") });
    pkg = { ...pkg, version: "0.1.1" };
    git("rm", "-q", "packages/tools/download.ts");
    const move = commit({
      "packages/scripts/download.ts": "// in scripts\nfetch(1)\n",
      "packages/a/package.json": manifest("0.1.1", {
        scripts: { build: "tsc && node tools/gen.ts", prepack: "node ../scripts/download.ts" },
      }),
    });
    expect(changedSince(pkg, root)).toEqual([]);
    const edit = commit({ "packages/scripts/download.ts": "// in scripts\nfetch(2)\n" });
    expect(changedSince(pkg, root)).toEqual([edit, move]);
  });

  it("ignores source edits that were fully reverted before release", () => {
    commit({ "packages/a/src/index.ts": "2" });
    commit({ "packages/a/src/index.ts": "1" });
    expect(changedSince(pkg, root)).toEqual([]);
  });
});

describe("releaseCheck", () => {
  const launcher = workspace("sanoma", "0.7.1");
  const connector = workspace("@sanoma-ai/connector-ghost", "0.7.1");
  const published = { ...connector, peerDependencies: { sanoma: "0.7.1" } };

  it("names a package npm does not have, and lists every version to publish", () => {
    const neon = workspace("@sanoma-ai/connector-neon", "0.7.1");
    const result = releaseCheck(
      [launcher, neon],
      npm([
        [launcher.name, "new version"],
        [neon.name, "new package"],
      ]),
      () => [],
    );
    expect(result.publish).toEqual(["sanoma@0.7.1", "@sanoma-ai/connector-neon@0.7.1"]);
    expect(result.problems).toEqual([
      '@sanoma-ai/connector-neon is not on npm: publish it once by hand and set its trusted publisher (README "Release")',
    ]);
  });

  it("names a public version of sanoma's whose source changed: one new version for them all", () => {
    const result = releaseCheck(
      [launcher, connector],
      npm([
        [launcher.name, launcher],
        [connector.name, published],
      ]),
      (p) => (p === launcher ? ["a1", "b2", "c3", "d4", "e5"] : []),
    );
    expect(result.publish).toEqual([]);
    expect(result.problems).toEqual([
      "sanoma@0.7.1 is on npm, but a1, b2, c3 and 2 more changed its source since: give it and every package released with sanoma a new version",
    ]);
  });

  it("names a binary whose source changed, and every package released with sanoma once one pins it", () => {
    const binary = binaryAt("@sanoma-ai/bridge-linux-x64", "0.5.0");
    const result = releaseCheck(
      [launcher, connector, binary],
      npm([
        [launcher.name, { ...launcher, optionalDependencies: { [binary.name]: "0.5.0" } }],
        [connector.name, published],
        [binary.name, binary],
      ]),
      (p) => (p === binary ? ["a1"] : []),
    );
    expect(result.problems).toEqual([
      "@sanoma-ai/bridge-linux-x64@0.5.0 is on npm, but a1 changed its source since: give it a new version",
      "sanoma@0.7.1 takes @sanoma-ai/bridge-linux-x64 0.5.0, not 0.5.1: give it a new version too",
    ]);
  });

  it("names a package at a version other than sanoma's, but not a binary", () => {
    const stale = workspace("@sanoma-ai/connector-neon", "0.3.0");
    const binary = binaryAt("@sanoma-ai/bridge-linux-x64", "0.5.0");
    const result = releaseCheck(
      [launcher, stale, binary],
      npm([
        [launcher.name, launcher],
        [stale.name, stale],
        [binary.name, binary],
      ]),
      () => [],
    );
    expect(result.problems).toEqual([
      "@sanoma-ai/connector-neon@0.3.0 is not at sanoma's version, 0.7.1: give it that one",
    ]);
  });

  it("passes when every public version matches its source", () => {
    const result = releaseCheck(
      [launcher, connector],
      npm([
        [launcher.name, launcher],
        [connector.name, published],
      ]),
      () => [],
    );
    expect(result).toEqual({ problems: [], publish: [] });
  });
});
