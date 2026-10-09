#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { schemaFile, toPath } from "../fixtures.ts";
import { readPins, testdata } from "../pins.ts";
import { parseSchema } from "../schema.ts";
import { generateResources } from "./generate.ts";
import type { ResourcesConfig } from "./types.ts";

const USAGE = "usage: sanoma-tfschema <resources.config.ts> <resources.gen.ts> [--fixtures <dir>]";

/**
 * `sanoma-tfschema`, this package's bin: writes a connector's `resources.gen.ts` from its
 * `resources.config.ts` and the recorded schema of the provider release the config names,
 * pinned in `<fixtures>/pins.json` (default: this package's `testdata/`). A connector's
 * `pnpm generate` runs it from the connector's directory. It reads files only: no network, no
 * provider. Importing this module runs nothing.
 */
export async function main(argv: string[]): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { fixtures: { type: "string" } },
  });
  const [configPath, outPath, ...extra] = positionals;
  if (!configPath || !outPath || extra.length > 0) throw new Error(USAGE);
  const fixtures = values.fixtures ?? toPath(testdata);
  const config = ((await import(pathToFileURL(resolve(configPath)).href)) as { default: ResourcesConfig }).default;
  const pinsFile = join(fixtures, "pins.json");
  const ref = readPins(pinsFile)[config.provider];
  if (!ref) throw new Error(`${configPath}: ${config.provider} is not pinned in ${pinsFile}`);
  const doc = parseSchema(readFileSync(schemaFile(fixtures, ref), "utf8"));
  writeFileSync(outPath, generateResources(doc, config, { provider: ref, config: configPath }));
  return `wrote ${outPath}: ${config.types.join(", ")}`;
}

if (import.meta.main) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
