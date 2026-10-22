import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// Keys of their own, each for one purpose, derived from the deployment's SANOMA_SECRETS_KEY: the
// staff login's cookie, the setup's state, and each visitor login's cookies.

/** A 32-byte key of its own for `purpose`, derived from `SANOMA_SECRETS_KEY` (HKDF-SHA256). */
const derivedKey = (secretsKey: string, purpose: string) =>
  Buffer.from(hkdfSync("sha256", secretsKey, "", purpose, 32));

/**
 * Signs short values (a session, a state) with a key derived from `SANOMA_SECRETS_KEY` for
 * `purpose`, so each use has a key of its own; `verify` compares in constant time.
 */
export function signer(secretsKey: string, purpose: string) {
  const key = derivedKey(secretsKey, purpose);
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  const verify = (payload: string, signature: string) => {
    const [expected, given] = [Buffer.from(sign(payload)), Buffer.from(signature)];
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return { sign, verify };
}

/**
 * The key a visitor login signs its cookies with (`LoginContext.key`): derived for `login <vendor>`
 * from `SANOMA_SECRETS_KEY`, which must be 32 bytes in base64 (as the stored credentials need it), hex.
 */
export function loginKey(vendor: string): string {
  const secretsKey = process.env.SANOMA_SECRETS_KEY;
  if (!secretsKey || Buffer.from(secretsKey, "base64").length !== 32) {
    throw new Error(
      "a visitor login needs SANOMA_SECRETS_KEY, 32 random bytes in base64 (`openssl rand -base64 32`), which its key is derived from",
    );
  }
  return derivedKey(secretsKey, `login ${vendor}`).toString("hex");
}
