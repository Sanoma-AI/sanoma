import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsOf, DEFAULT_DATABASE_URL, type SanomaConfig } from "@sanoma/workflows";

const HEADER = `# Copy to .env (ignored by git; \`sanoma\` loads it before reading the config). Never commit values.
# The first block is what sanoma needs before anything runs. The vendor variables below it can
# also be set on the app's connector pages (stored in the database and loaded by the worker); a
# value set here wins over a stored one and cannot be changed from the page. An empty value is
# the same as unset.
`;

/**
 * The text of `.env.example` for a config: the header, the variables sanoma reads (commented
 * out, with their defaults), then a block per vendor in the drivers' order with each variable
 * the drivers declare (`credentialsOf`), its description as a comment; an optional one is
 * commented out. The same config gives the same text, so `sanoma env --check` can compare.
 */
export function renderEnvExample(config: SanomaConfig): string {
  const lines = [
    HEADER,
    `# Optional. Postgres for the worker and the app; default ${config.databaseUrl ?? DEFAULT_DATABASE_URL}.`,
    "# SANOMA_DATABASE_URL=",
    "# Optional. The app's port; default 3000.",
    "# SANOMA_APP_PORT=",
  ];
  for (const [vendor, variables] of credentialsOf(config.drivers, () => undefined)) {
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
export function writeEnvExample(
  root: string,
  config: SanomaConfig,
  { check }: { check: boolean },
): { changed: boolean } {
  const file = join(root, ".env.example");
  const text = renderEnvExample(config);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const changed = current !== text;
  if (changed && !check) writeFileSync(file, text);
  return { changed };
}
