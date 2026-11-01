import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

/** Bootstrap only: never resolves through the secret store that the key unlocks. */
export function deploymentKey(
  name: "SANOMA_SECRETS_KEY" | "SANOMA_SIGNING_KEY",
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const value = env[name];
  const file = env[`${name}_FILE`];
  if (value && file) throw new Error(`Set only one of ${name} and ${name}_FILE`);
  let encoded = value;
  if (file) {
    try {
      encoded = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${name}_FILE could not be read`);
    }
  }
  const key = encoded === undefined ? undefined : keyBytes(encoded);
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
