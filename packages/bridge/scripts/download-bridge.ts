// `pnpm bridge:download`: puts a provider-bridge binary in packages/bridge/bin/ and prints the
// path to export as SANOMA_BRIDGE_BIN. It downloads the release `RELEASE` pins, checked against
// its sha256, or with `--source` builds one from a provider-bridge checkout (Go from the
// checkout's .mise.toml). Each `@sanoma-ai/bridge-<platform>` package fills its `bin/` with it
// when packed (`--platform`).
//
//   pnpm bridge:download                   # the pinned release for this platform
//   pnpm bridge:download --platform linux-x64 --out /tmp/provider-bridge
//   pnpm bridge:download --source          # finds ../provider-bridge beside the repo (or an ancestor)
//   SANOMA_BRIDGE_SRC=~/src/provider-bridge pnpm bridge:download --source
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BRIDGE_PLATFORMS } from "../src/bin.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Where the binary goes by default (gitignored). */
export const defaultBin = join(packageDir, "bin", "provider-bridge");

/** A provider-bridge release on GitHub, and the sha256 of each platform's archive. */
export interface Release {
  owner: string;
  repo: string;
  /** Without the tag's `v`, e.g. "0.1.0". */
  version: string;
  /** Hex sha256 of each archive (its line in the release's SHA256SUMS), by `${process.platform}-${process.arch}`. */
  sha256: Record<string, string>;
}

/**
 * TODO(release): the release `downloadRelease` fetches and the platform packages ship. Filled by
 * hand once provider-bridge v0.1.0 is tagged, from that release's SHA256SUMS, never from "latest";
 * until then `downloadRelease` refuses, and so does packing a platform package.
 */
export const RELEASE: Release = {
  owner: "Sanoma-AI",
  repo: "provider-bridge",
  version: "",
  sha256: {
    "darwin-arm64": "",
    "darwin-x64": "",
    "linux-arm64": "",
    "linux-x64": "",
  },
};

/** The name and URL of `platform`'s archive in `release` (goreleaser's `<os>_<arch>`, with Go's `amd64` for `x64`). */
export function releaseArchive(platform: string, release: Release = RELEASE): { name: string; url: string } {
  const [os, arch] = platform.split("-");
  const name = `provider-bridge_${release.version}_${os}_${arch === "x64" ? "amd64" : arch}.tar.gz`;
  const url = `https://github.com/${release.owner}/${release.repo}/releases/download/v${release.version}/${name}`;
  return { name, url };
}

/**
 * Downloads `platform`'s archive of `release`, checks it against its pinned sha256 and extracts
 * the binary to `out`, executable. Returns `out`. Writes nothing when the check fails.
 */
export async function downloadRelease(
  out: string = defaultBin,
  platform: string = `${process.platform}-${process.arch}`,
  release: Release = RELEASE,
): Promise<string> {
  if (!BRIDGE_PLATFORMS.includes(platform)) throw new Error(`provider-bridge has no release for ${platform}`);
  const expected = release.sha256[platform];
  if (!release.version || !expected) {
    throw new Error(
      `no pinned provider-bridge release for ${platform} (RELEASE in ${fileURLToPath(import.meta.url)}); build from source with --source`,
    );
  }
  const { name, url } = releaseArchive(platform, release);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`${name} has sha256 ${actual}, not the pinned ${expected}; refusing it`);

  const dir = mkdtempSync(join(tmpdir(), "provider-bridge-"));
  try {
    writeFileSync(join(dir, name), archive);
    const tar = spawnSync("tar", ["-xzf", name, "provider-bridge"], {
      cwd: dir,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) throw new Error(`tar -xzf ${name} failed (exit ${tar.status})`);
    // Copied beside `out`, then renamed over it: a reader never sees half a binary.
    const target = resolve(out);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dir, "provider-bridge"), `${target}.tmp`);
    chmodSync(`${target}.tmp`, 0o755);
    renameSync(`${target}.tmp`, target);
    return target;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The provider-bridge checkout: `SANOMA_BRIDGE_SRC`, else a `provider-bridge` directory beside this repo or one of its ancestors. */
export function findCheckout(): string {
  const given = process.env.SANOMA_BRIDGE_SRC;
  if (given) return resolve(given);
  for (let dir = packageDir; dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dirname(dir), "provider-bridge");
    if (existsSync(join(candidate, "cmd", "provider-bridge"))) return candidate;
  }
  throw new Error("no provider-bridge checkout found beside this repo; set SANOMA_BRIDGE_SRC to one");
}

/**
 * Builds `cmd/provider-bridge` from the checkout's vendored modules into `out`, with the Go
 * version the checkout pins (through mise when it is installed). Returns `out`.
 */
export function buildBridge(out: string = defaultBin, checkout: string = findCheckout()): string {
  const build = ["go", "build", "-mod=vendor", "-o", resolve(out), "./cmd/provider-bridge"];
  const hasMise = spawnSync("mise", ["--version"], { stdio: "ignore" }).status === 0;
  const [cmd, ...args] = hasMise ? ["mise", "x", "--", ...build] : build;
  const result = spawnSync(cmd!, args, { cwd: checkout, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} failed in ${checkout} (exit ${result.status})`);
  return resolve(out);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, platform: { type: "string" }, source: { type: "boolean" } },
  });
  if (values.source) {
    if (values.platform) throw new Error("--platform downloads a release; --source builds for this platform only");
    const bin = buildBridge(values.out);
    console.log(`built ${bin}\n\nexport SANOMA_BRIDGE_BIN=${bin}`);
  } else {
    const bin = await downloadRelease(values.out, values.platform);
    console.log(`downloaded provider-bridge ${RELEASE.version} to ${bin}\n\nexport SANOMA_BRIDGE_BIN=${bin}`);
  }
}
