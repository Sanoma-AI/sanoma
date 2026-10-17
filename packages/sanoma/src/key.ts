import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const KEY = "SANOMA_SECRETS_KEY";

/**
 * The one writer of `SANOMA_SECRETS_KEY`, which encrypts the stored credentials: unless `file`
 * (a `.env`) already sets it, makes one (32 random bytes, base64) and appends it, making the file
 * readable by its owner alone when it is new. Returns the key it made, or undefined when it kept the file's.
 */
export function writeSecretsKey(file: string): string | undefined {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (parseEnv(text)[KEY]) return undefined;
  const key = randomBytes(32).toString("base64");
  const gap = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${gap}${KEY}=${key}\n`, { mode: 0o600 });
  return key;
}

/**
 * Makes sure `SANOMA_SECRETS_KEY` is set: when the environment (with `<dir>/.env` loaded) has
 * none, writes one to `<dir>/.env` (`writeSecretsKey`), sets it here, and logs one line.
 */
export function ensureSecretsKey(dir: string, log: (line: string) => void): void {
  if (process.env[KEY]) return;
  const file = join(dir, ".env");
  const key = writeSecretsKey(file);
  if (key === undefined) return;
  process.env[KEY] = key;
  log(`created ${KEY} in ${file}: it encrypts the stored credentials, so keep it with the database`);
}
