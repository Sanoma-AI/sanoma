import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateResources } from "./generate.ts";
import type { ResourcesConfig, TfSchemaDocument } from "./types.ts";

/*
 * Writes a connector's `resources.gen.ts` from a recorded schema document and its
 * `resources.config.ts`. Each connector's `pnpm generate` runs it, from the connector's
 * directory, with Node's own TypeScript support:
 *
 *   node ../../packages/workflows/src/tfschema/cli.ts <schema.json> <resources.config.ts> <out.ts>
 *
 * It reads files only: no network, no provider.
 */

const [schemaPath, configPath, outPath] = process.argv.slice(2);
if (!schemaPath || !configPath || !outPath) {
  console.error("usage: cli.ts <schema.json> <resources.config.ts> <resources.gen.ts>");
  process.exit(2);
}
const doc = JSON.parse(readFileSync(schemaPath, "utf8")) as TfSchemaDocument;
const config = ((await import(pathToFileURL(resolve(configPath)).href)) as { default: ResourcesConfig }).default;
writeFileSync(outPath, generateResources(doc, config, { schema: schemaPath, config: configPath }));
console.log(`wrote ${outPath}: ${config.types.join(", ")}`);
