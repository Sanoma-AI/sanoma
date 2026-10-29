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
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, "base64").length !== 32) {
    throw new Error(`${name} must be 32 random bytes in base64; supply ${name} or ${name}_FILE`);
  }
  return Buffer.from(encoded, "base64");
}
