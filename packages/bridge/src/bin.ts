import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The platforms provider-bridge is released for, as `${process.platform}-${process.arch}`. Each
 * has a package `@sanoma-ai/bridge-<platform>`, an optional dependency of this one, that holds
 * its binary in `bin/provider-bridge`.
 */
export const BRIDGE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

export interface BridgeBinOptions {
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Default: this process's `${process.platform}-${process.arch}`. */
  platform?: string;
  /** Where the platform package is resolved from (a file path or URL). Default: this module. */
  from?: string | URL;
}

/**
 * The `provider-bridge` binary `startBridge` runs when it is given none: `SANOMA_BRIDGE_BIN`,
 * else the binary of the installed `@sanoma-ai/bridge-<platform>` package; throws, saying how
 * to get one, when there is neither.
 */
export function bridgeBin({
  env = process.env,
  platform = `${process.platform}-${process.arch}`,
  from = import.meta.url,
}: BridgeBinOptions = {}): string {
  if (env.SANOMA_BRIDGE_BIN) return env.SANOMA_BRIDGE_BIN;
  const name = `@sanoma-ai/bridge-${platform}`;
  if (!BRIDGE_PLATFORMS.includes(platform)) {
    throw new Error(`provider-bridge: no release for ${platform}. ${howToGetOne}`);
  }
  try {
    const bin = join(dirname(createRequire(from).resolve(`${name}/package.json`)), "bin", "provider-bridge");
    if (existsSync(bin)) return bin;
  } catch {
    // not installed
  }
  throw new Error(
    `provider-bridge: no binary. ${name}, an optional dependency of @sanoma-ai/bridge, is not installed ` +
      `(installs that omit optional dependencies leave it out). ${howToGetOne}`,
  );
}

const howToGetOne =
  "Set SANOMA_BRIDGE_BIN to a provider-bridge binary (from https://github.com/Sanoma-AI/provider-bridge, " +
  "or `pnpm bridge:download` in a sanoma checkout), or pass `bin`.";
