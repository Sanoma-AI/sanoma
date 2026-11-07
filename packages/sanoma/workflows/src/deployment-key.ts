import { hkdfSync } from "node:crypto";

/** The deployment's own keys: bound only to the environment or bootstrap, never written by the runtime. */
export const DEPLOYMENT_KEYS: readonly string[] = ["SANOMA_SIGNING_KEY", "SANOMA_SECRETS_KEY"];
export type DeploymentKeyName = "SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY";

/**
 * Bootstrap only: never resolves through the secret store that the key unlocks. `<name>` from the
 * environment, or the file `<name>_FILE` names where there is a file system.
 */
export function deploymentKey(name: DeploymentKeyName, env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env[name];
  const file = env[`${name}_FILE`];
  if (value && file) throw new Error(`Set only one of ${name} and ${name}_FILE`);
  let encoded = value;
  if (file) {
    // Node's `fs` where there is a file system (Node), found at the call rather than imported:
    // workerd has no files to mount a key in, so there a `_FILE` input is refused.
    const fs = (globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined)?.getBuiltinModule?.(
      "node:fs",
    ) as typeof import("node:fs") | undefined;
    if (!fs) throw new Error(`${name}_FILE names a file, and this host has no file system: set ${name}`);
    try {
      encoded = fs.readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${name}_FILE could not be read`);
    }
  }
  const key = encoded ? keyBytes(encoded) : undefined;
  if (!key) throw new Error(`${name} must be 32 random bytes in base64; supply ${name} or ${name}_FILE`);
  return key;
}

/**
 * The 32 bytes of a key written as text: padded base64 (`sanoma key`), or base64url without
 * padding (a `secret(..., { generate: true })` marker's value). Anything else is `undefined`.
 */
export function keyBytes(text: string): Buffer | undefined {
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, "base64");
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) return Buffer.from(text, "base64url");
  return undefined;
}

/**
 * A 32-byte key of its own for `purpose`, derived from a deployment's signing key (HKDF-SHA256
 * over its base64 text), as that deployment derives it from its `SANOMA_SIGNING_KEY`.
 */
export const deriveSigningKey = (signingKey: Buffer, purpose: string): Buffer =>
  Buffer.from(hkdfSync("sha256", signingKey.toString("base64"), "", purpose, 32));

/**
 * A 32-byte key of its own for `purpose`, derived from `SANOMA_SIGNING_KEY` (`deriveSigningKey`):
 * each use of the signing key (a login's cookies, the setup's state, sealed values) gets a key no
 * other use shares.
 */
export const signingKeyFor = (purpose: string): Buffer =>
  deriveSigningKey(deploymentKey("SANOMA_SIGNING_KEY"), purpose);
