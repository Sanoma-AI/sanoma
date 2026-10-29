import { deploymentKey } from "@sanoma-ai/workflows";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// Keys of their own, each for one purpose, derived from the deployment's SANOMA_SIGNING_KEY: the
// staff login's cookie, the setup's state, and each visitor login's cookies.

/** A 32-byte key of its own for `purpose`, derived from `SANOMA_SIGNING_KEY` (HKDF-SHA256). */
const derivedKey = (secretsKey: string, purpose: string) =>
  Buffer.from(hkdfSync("sha256", secretsKey, "", purpose, 32));

/**
 * Signs short values (a session, a state) with a key derived from `SANOMA_SIGNING_KEY` for
 * `purpose`, so each use has a key of its own; `verify` compares in constant time.
 */
export function signer(signingKey: string, purpose: string) {
  const key = derivedKey(signingKey, purpose);
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  const verify = (payload: string, signature: string) => {
    const [expected, given] = [Buffer.from(sign(payload)), Buffer.from(signature)];
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return { sign, verify };
}

/**
 * The key a visitor login signs its cookies with (`LoginContext.key`): derived for `login <vendor>`
 * from `SANOMA_SIGNING_KEY`, an independent 32-byte base64 bootstrap key, hex.
 */
export function loginKey(vendor: string): string {
  const signingKey = deploymentKey("SANOMA_SIGNING_KEY").toString("base64");
  return derivedKey(signingKey, `login ${vendor}`).toString("hex");
}
