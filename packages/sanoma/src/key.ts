import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const KEY = "SANOMA_SECRETS_KEY";

/**
 * Adds each variable `file` (a `.env`) does not set yet, an empty value counting as unset, and
 * keeps the file's own; a new file is readable by its owner alone. Returns the names it added.
 */
export function addToEnv(file: string, values: Record<string, string>): string[] {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const set = parseEnv(text);
  const added = Object.keys(values).filter((name) => !set[name]);
  if (!added.length) return added;
  const gap = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(file, gap + added.map((name) => `${name}=${values[name]}\n`).join(""), { mode: 0o600 });
  return added;
}

/**
 * The one writer of `SANOMA_SECRETS_KEY`, which encrypts the stored credentials: unless `file`
 * already sets it, makes one (32 random bytes, base64) and adds it (`addToEnv`). Returns the key
 * it made, or undefined when it kept the file's.
 */
export function writeSecretsKey(file: string): string | undefined {
  const key = randomBytes(32).toString("base64");
  return addToEnv(file, { [KEY]: key }).length ? key : undefined;
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
