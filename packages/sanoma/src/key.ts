import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const KEY = "SANOMA_SECRETS_KEY";
const SIGNING_KEY = "SANOMA_SIGNING_KEY";

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
  chmodSync(file, 0o600);
  return added;
}

/** Creates independent local bootstrap keys; external stores need only signing. */
export async function ensureDeploymentKeys(
  dir: string,
  log: (line: string) => void,
  options: { externalStore?: boolean } = {},
): Promise<void> {
  // Keep init's key generation independent of loading the runtime. Startup uses its one
  // decoder so direct and mounted values have identical validation everywhere.
  const { deploymentKey } = await import("@sanoma-ai/workflows");
  const file = join(dir, ".env");
  const names: (typeof SIGNING_KEY | typeof KEY)[] = [SIGNING_KEY];
  if (!options.externalStore) names.push(KEY);
  for (const name of names) {
    if (process.env[name] && process.env[`${name}_FILE`]) throw new Error(`Set only one of ${name} and ${name}_FILE`);
    if (process.env[name] || process.env[`${name}_FILE`]) {
      deploymentKey(name);
      continue;
    }
    const current = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    if (current[name] && current[`${name}_FILE`]) throw new Error(`Set only one of ${name} and ${name}_FILE`);
    if (current[name] || current[`${name}_FILE`]) {
      if (current[name]) process.env[name] = current[name];
      if (current[`${name}_FILE`]) process.env[`${name}_FILE`] = current[`${name}_FILE`];
      deploymentKey(name);
      continue;
    }
    const key = randomBytes(32).toString("base64");
    addToEnv(file, { [name]: key });
    process.env[name] = key;
    log(`created ${name} in ${file}`);
  }
}

/** New local company bootstrap: signing and row encryption have independent random keys. */
export function writeDeploymentKeys(file: string): void {
  const current = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const values: Record<string, string> = {};
  for (const name of [SIGNING_KEY, KEY]) {
    if (current[name] && current[`${name}_FILE`]) throw new Error(`Set only one of ${name} and ${name}_FILE`);
    if (!current[name] && !current[`${name}_FILE`]) values[name] = randomBytes(32).toString("base64");
  }
  addToEnv(file, values);
}
