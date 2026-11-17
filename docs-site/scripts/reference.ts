// `pnpm --dir docs-site reference`: writes src/data/reference.json, what the reference pages draw:
// every connector in connectors/ with its operations, each one's effect, description and its input
// and output as JSON Schema. Read from the connectors' own source, so a page cannot say what the
// code does not. Run before `astro dev` and `astro build`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// By path, not by name: the site is no workspace package (see pnpm-workspace.yaml here), so nothing links `sanoma` into it.
import { jsonSchemaOf } from "../../packages/sanoma/workflows/src/define.ts";
import {
  type Connector,
  CONNECTOR_FORMAT,
  indexConnectors,
  type Op,
  VENDOR,
} from "../../packages/sanoma/workflows/src/op.ts";

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
  /** The folder under connectors/, and the page's address: `/reference/connectors/<slug>/`. */
  slug: string;
  title: string;
  package: string;
  version: string;
  description?: string;
  /** Where its code and README are: its package.json's `homepage`. */
  homepage?: string;
  /** Its resource types, which a data file under `resources/` declares. */
  resources: string[];
  operations: OperationReference[];
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The folders under connectors/, each a connector's package, in name order. */
const connectorDirs = () =>
  readdirSync(join(repo, "connectors"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

const isConnector = (value: unknown): value is Connector<string, any> =>
  typeof value === "object" && value !== null && (value as Connector<string, any>)[VENDOR]?.format === CONNECTOR_FORMAT;

/** Every connector under connectors/, by folder name, as its package exports it. */
export async function readReference(): Promise<ConnectorReference[]> {
  const out: ConnectorReference[] = [];
  for (const slug of connectorDirs()) {
    const dir = join(repo, "connectors", slug);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      description?: string;
      homepage?: string;
    };
    const exported = (await import(pathToFileURL(join(dir, "src", "index.ts")).href)) as Record<string, unknown>;
    // One connector exported under two names is one.
    const connectors = [...new Set(Object.values(exported).filter(isConnector))];
    // A page is a folder's: its address and its README's are the folder's name.
    if (connectors.length !== 1) {
      throw new Error(`connectors/${slug}/src/index.ts exports ${connectors.length} connectors: a page takes one`);
    }
    const connector = connectors[0]!;
    const owner = connector[VENDOR];
    out.push({
      slug,
      title: owner.info?.title ?? owner.id,
      package: manifest.name,
      version: manifest.version,
      description: manifest.description,
      homepage: manifest.homepage,
      resources: owner.resources.map((resource) => `${owner.id}.${resource.type}`),
      operations: [...indexConnectors([connector]).values()].map((op) => ({
        id: op.id,
        resource: op.resource,
        name: op.name,
        effect: op.effect,
        idempotent: op.idempotent,
        description: op.description,
        input: jsonSchemaOf(op.input, "input"),
        output: jsonSchemaOf(op.output, "output"),
      })),
    });
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
