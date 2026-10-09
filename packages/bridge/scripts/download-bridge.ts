// `pnpm bridge:download`: puts a provider-bridge binary in packages/bridge/bin/ and prints the
// path to export as SANOMA_BRIDGE_BIN. provider-bridge publishes no releases yet, so for now it
// builds one from a provider-bridge checkout (Go from the checkout's .mise.toml).
//
//   pnpm bridge:download                   # finds ../provider-bridge beside the repo (or an ancestor)
//   SANOMA_BRIDGE_SRC=~/src/provider-bridge pnpm bridge:download
//   pnpm bridge:download --out /tmp/provider-bridge
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Where the binary goes by default (gitignored). */
export const defaultBin = join(packageDir, "bin", "provider-bridge");

/**
 * TODO(release): the pinned release to download once provider-bridge publishes them. Fill in by
 * hand from the release's checksums, never from "latest"; until then `downloadRelease` refuses
 * and the script builds from source.
 */
export const RELEASE = {
  owner: "Sanoma-AI",
  repo: "provider-bridge",
  version: "", // e.g. "0.1.0"
  /** Hex sha256 of each archive, by `${process.platform}-${process.arch}`. */
  sha256: {
    "darwin-arm64": "",
    "darwin-x64": "",
    "linux-arm64": "",
    "linux-x64": "",
  } as Record<string, string>,
};

/**
 * STUB: downloads `RELEASE` for this platform, checks the archive against its pinned sha256 and
 * extracts the binary to `out`. Not implemented: there are no releases yet.
 */
export function downloadRelease(_out: string): never {
  throw new Error(
    `provider-bridge has no pinned release yet (RELEASE.version is empty in ${fileURLToPath(import.meta.url)}); build from source instead`,
  );
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
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const bin = buildBridge(values.out);
  console.log(`built ${bin}\n\nexport SANOMA_BRIDGE_BIN=${bin}`);
}
