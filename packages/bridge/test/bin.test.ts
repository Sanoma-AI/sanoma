import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeBin } from "../src/bin.ts";
import { downloadRelease, type Release } from "../scripts/download-bridge.ts";

let dir: string;
beforeEach(() => {
  // Real: require resolves through symlinks, such as macOS's /var -> /private/var.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-bridge-bin-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Installs a fake `@sanoma-ai/bridge-<platform>` under `dir`, with its binary unless `empty`. */
function installPlatformPackage(platform: string, { empty = false } = {}) {
  const pkg = join(dir, "node_modules", "@sanoma-ai", `bridge-${platform}`);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@sanoma-ai/bridge-${platform}` }));
  if (!empty) writeFileSync(join(pkg, "bin", "provider-bridge"), "");
  return join(pkg, "bin", "provider-bridge");
}

/** A release archive holding `provider-bridge`, and a release pinning `sha256` for linux-x64. */
function archive(sha256?: string) {
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "provider-bridge"), "#!/bin/sh\necho bridge\n");
  writeFileSync(join(src, "LICENSE"), "license");
  const tgz = join(dir, "archive.tar.gz");
  expect(spawnSync("tar", ["-czf", tgz, "-C", src, "provider-bridge", "LICENSE"]).status).toBe(0);
  const bytes = readFileSync(tgz);
  const release: Release = {
    owner: "Sanoma-AI",
    repo: "provider-bridge",
    version: "9.9.9",
    sha256: { "linux-x64": sha256 ?? createHash("sha256").update(bytes).digest("hex") },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  return { release, fetch };
}

/** Where `bridgeBin` resolves the platform package from: a module in `dir`. */
const from = () => join(dir, "index.js");

describe("bridgeBin", () => {
  it("takes SANOMA_BRIDGE_BIN first, then the installed platform package's binary", () => {
    const installed = installPlatformPackage("linux-x64");
    expect(bridgeBin({ env: { SANOMA_BRIDGE_BIN: "/opt/provider-bridge" }, platform: "linux-x64", from: from() })).toBe(
      "/opt/provider-bridge",
    );
    expect(bridgeBin({ env: { SANOMA_BRIDGE_BIN: "" }, platform: "linux-x64", from: from() })).toBe(installed);
  });

  it("says how to get a binary when the platform package is missing or empty", () => {
    installPlatformPackage("darwin-arm64", { empty: true });
    for (const platform of ["darwin-arm64", "linux-x64"]) {
      expect(() => bridgeBin({ env: {}, platform, from: from() })).toThrow(
        new RegExp(`@sanoma-ai/bridge-${platform}, an optional dependency.*not installed.*SANOMA_BRIDGE_BIN`),
      );
    }
  });

  it("names a platform with no release", () => {
    expect(() => bridgeBin({ env: {}, platform: "win32-x64", from: from() })).toThrow(
      /no release for win32-x64\. Set SANOMA_BRIDGE_BIN/,
    );
  });
});

describe("downloadRelease", () => {
  it("downloads the pinned archive, checks it and extracts the binary, executable", async () => {
    const { release, fetch } = archive();
    const out = join(dir, "out", "provider-bridge");
    await expect(downloadRelease(out, "linux-x64", release)).resolves.toBe(out);
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/Sanoma-AI/provider-bridge/releases/download/v9.9.9/provider-bridge_9.9.9_linux_amd64.tar.gz",
    );
    expect(readFileSync(out, "utf8")).toBe("#!/bin/sh\necho bridge\n");
    expect(statSync(out).mode & 0o777).toBe(0o755);
  });

  it("refuses an archive whose sha256 is not the pinned one, and writes nothing", async () => {
    const { release } = archive("0".repeat(64));
    const out = join(dir, "out", "provider-bridge");
    await expect(downloadRelease(out, "linux-x64", release)).rejects.toThrow(
      /provider-bridge_9\.9\.9_linux_amd64\.tar\.gz has sha256 [0-9a-f]{64}, not the pinned 0{64}; refusing it/,
    );
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("refuses without a pinned release", async () => {
    const { release } = archive();
    await expect(downloadRelease(join(dir, "out"), "darwin-arm64", release)).rejects.toThrow(
      /no pinned provider-bridge release for darwin-arm64/,
    );
  });
});
