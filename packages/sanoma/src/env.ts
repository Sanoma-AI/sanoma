import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsOf } from "@sanoma-ai/workflows";
import type { Loaded } from "./config.ts";

const HEADER = `# Copy to .env (ignored by git; \`sanoma\` loads it before reading the config). Never commit values.
# The first block bootstraps the runtime. Secret references use the configured store; to read
# an environment value through that store, declare an explicit env binding in sanoma.config.ts.
# Connector driver migration to named per-call authentication is tracked separately.
`;

/**
 * The text of `.env.example` for a config: the header, the variables sanoma reads (commented
 * out, with their defaults), then a block per vendor in the connectors' order with each variable
 * its connector's driver declares (`credentialsOf`), its description as a comment; an optional
 * one is commented out. The same config gives the same text, so `sanoma env --check` can compare.
 * Reads the config as loaded, with its resolution.
 */
export function renderEnvExample({ config, resolved }: Pick<Loaded, "config" | "resolved">): string {
  const lines = [
    HEADER,
    // The default: the config's own, else the company's own Postgres, never this environment's.
    config.databaseUrl === undefined
      ? "# Optional. Postgres for the worker and the app; default the company's own in .sanoma/postgres."
      : `# Optional. Postgres for the worker and the app; default ${config.databaseUrl}.`,
    "# SANOMA_DATABASE_URL=",
    "# Built-in encrypted store only: 32 random bytes, base64. Keep separately from database backups.",
    "# SANOMA_SECRETS_KEY=",
    "# SANOMA_SECRETS_KEY_FILE=",
    "# App signing: an independent 32-byte base64 key. Changing it invalidates signed sessions.",
    "# For each key, use its value OR its _FILE path. First local start generates missing keys.",
    "# SANOMA_SIGNING_KEY=",
    "# SANOMA_SIGNING_KEY_FILE=",
    "# Optional. The app's port; default 3000.",
    "# SANOMA_APP_PORT=",
    "# Optional. The address the app listens on; default 127.0.0.1. Any other needs GitHub sign-in.",
    "# SANOMA_APP_HOST=",
    "# Optional. GitHub sign-in: the OAuth client of the company's GitHub App. Who may sign in is",
    "# resources/people.ts. Both or neither.",
    "# SANOMA_GITHUB_CLIENT_ID=",
    "# SANOMA_GITHUB_CLIENT_SECRET=",
  ];
  for (const [vendor, variables] of credentialsOf(resolved.driversByVendor, () => undefined)) {
    lines.push("");
    for (const { name, description, optional } of variables) {
      const about = description === undefined ? "" : `: ${description}`;
      lines.push(`# ${optional ? "Optional. " : ""}${vendor}${about}`, `${optional ? "# " : ""}${name}=`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes `<root>/.env.example` from the config, unless `check`: then it only says whether the
 * file is already what it would write. `changed` is true when the file was written, or would be.
 */
export function writeEnvExample(loaded: Loaded, { check }: { check: boolean }): { changed: boolean } {
  const file = join(loaded.root, ".env.example");
  const text = renderEnvExample(loaded);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const changed = current !== text;
  if (changed && !check) writeFileSync(file, text);
  return { changed };
}
