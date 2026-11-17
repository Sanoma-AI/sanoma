// `pnpm --dir docs-site reference`: writes src/data/reference.json, what the reference
// pages draw: every connector in connectors/ with its operations, each one's effect, description
// and its input and output as JSON Schema. Read from the connectors' own source, so a page cannot
// say what the code does not. Run before `astro dev` and `astro build`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// By path, not by name: the site is no workspace package (see pnpm-workspace.yaml here), so nothing links `sanoma` into it.
import { jsonSchemaOf } from "../../packages/sanoma/workflows/src/define.ts";
import { type Connector, isOp, type Op, VENDOR } from "../../packages/sanoma/workflows/src/index.ts";

export interface OperationReference {
  /** `<vendor>.<resource>.<name>`, as a workflow's `uses` and the policy name it. */
  id: string;
  resource: string;
  name: string;
  effect: Op["effect"];
  idempotent: boolean;
  description?: string;
  /** What a caller sends, and what the call answers: JSON Schema, draft 2020-12. */
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface ConnectorReference {
  /** The folder under connectors/, and the page's address: `/reference/<slug>/`. */
  slug: string;
  vendor: string;
  title: string;
  package: string;
  version: string;
  description?: string;
  /** Its resource types, which a data file under `resources/` declares. */
  resources: string[];
  operations: OperationReference[];
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const isConnector = (value: unknown): value is Connector<string, any> =>
  typeof value === "object" && value !== null && VENDOR in value;

/** Every connector under connectors/, by folder name, as its package exports it. */
export async function readReference(): Promise<ConnectorReference[]> {
  const out: ConnectorReference[] = [];
  const dirs = readdirSync(join(repo, "connectors"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const slug of dirs) {
    const dir = join(repo, "connectors", slug);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      description?: string;
    };
    const exported = (await import(pathToFileURL(join(dir, "src", "index.ts")).href)) as Record<string, unknown>;
    const connectors = Object.values(exported).filter(isConnector);
    if (!connectors.length) throw new Error(`connectors/${slug}/src/index.ts exports no connector`);
    for (const connector of connectors) {
      const owner = connector[VENDOR];
      const operations: OperationReference[] = [];
      for (const [resource, group] of Object.entries(connector)) {
        for (const [name, op] of Object.entries(group as Record<string, unknown>)) {
          if (!isOp(op)) continue;
          operations.push({
            id: op.id,
            resource,
            name,
            effect: op.effect,
            idempotent: op.idempotent,
            ...(op.description && { description: op.description }),
            input: jsonSchemaOf(op.input, "input"),
            output: jsonSchemaOf(op.output, "output"),
          });
        }
      }
      out.push({
        slug: connectors.length > 1 ? `${slug}-${owner.id}` : slug,
        vendor: owner.id,
        title: owner.info?.title ?? owner.id,
        package: manifest.name,
        version: manifest.version,
        ...(manifest.description && { description: manifest.description }),
        resources: owner.resources.map((resource) => `${owner.id}.${resource.type}`),
        operations,
      });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reference = await readReference();
  const file = join(repo, "docs-site", "src", "data", "reference.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(reference, null, 2)}\n`);
  const operations = reference.reduce((sum, connector) => sum + connector.operations.length, 0);
  console.log(`reference: ${reference.length} connectors, ${operations} operations`);
}
