import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "@sanoma-ai/workflows";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, UsageError } from "../src/config.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A company in a fresh directory: its files by path. */
function company(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "sanoma-config-"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

const CONFIG = (collections = "") =>
  `import { defineConfig } from "sanoma";\n${collections ? 'import { leads } from "./resources/data.ts";\n' : ""}` +
  `export default defineConfig({ workflows: [], connectors: []${collections} });\n`;
const DATA = `import { collection } from "sanoma/data";
export const leads = collection({ name: "leads", key: "id", fields: { id: "text" } });
export const deals = collection({ name: "deals", key: "id", fields: { id: "text", won: "boolean" } });
`;

/** A workflow file's text: `name`, its default export. */
const workflow = (name: string) =>
  `import { defineWorkflow } from "sanoma";\nexport default defineWorkflow({ name: "${name}", trigger: "manual", uses: [], run: async () => ({}) });\n`;

describe("loadConfig", () => {
  it("adds the collections resources/data.ts exports to the config's", async () => {
    const { config } = await loadConfig(company({ "sanoma.config.ts": CONFIG(), "resources/data.ts": DATA }));
    expect(config.collections?.map((c) => c.name)).toEqual(["leads", "deals"]);
  });

  it("keeps the collections a config lists, each once", async () => {
    const { config } = await loadConfig(
      company({ "sanoma.config.ts": CONFIG(", collections: [leads]"), "resources/data.ts": DATA }),
    );
    expect(config.collections?.map((c) => c.name)).toEqual(["leads", "deals"]);
  });

  it("leaves a `collections` that is no list for resolveConfig to explain", async () => {
    const { config } = await loadConfig(
      company({ "sanoma.config.ts": CONFIG(", collections: leads as never"), "resources/data.ts": DATA }),
    );
    expect(() => resolveConfig(config)).toThrow(/^The config's `collections` must be an array/);
  });

  it("leaves a config without resources/data.ts as it is", async () => {
    const { config } = await loadConfig(company({ "sanoma.config.ts": CONFIG() }));
    expect(config.collections).toBeUndefined();
  });

  it("refuses an export of resources/data.ts that is not a collection, naming the file", async () => {
    const root = company({ "sanoma.config.ts": CONFIG(), "resources/data.ts": `${DATA}export const n = 1;\n` });
    const loading = loadConfig(root);
    await expect(loading).rejects.toThrow(UsageError);
    await expect(loading).rejects.toThrow(/\/resources\/data\.ts exports n, which is not a collection: /);
  });

  it("adds each workflow workflows/ and the apps' workflows/ export by default, a listed one once, and skips a helper", async () => {
    const { config } = await loadConfig(
      company({
        "sanoma.config.ts":
          'import { defineConfig } from "sanoma";\nimport hello from "./workflows/hello.ts";\nexport default defineConfig({ workflows: [hello], connectors: [] });\n',
        "workflows/hello.ts": workflow("hello"),
        "workflows/nested/later.ts": workflow("later"),
        "workflows/helper.ts": "export const two = 2;\n",
        "workflows/hello.test.ts": "throw new Error('a test is not imported');\n",
        "apps/crm/workflows/follow-up.ts": workflow("follow-up"),
      }),
    );
    expect(config.workflows?.map((w) => w.name)).toEqual(["hello", "later", "crm.follow-up"]);
  });

  it("refuses a workflows/ file whose default export is no workflow, naming the file", async () => {
    const root = company({
      "sanoma.config.ts": 'import { defineConfig } from "sanoma";\nexport default defineConfig({ connectors: [] });\n',
      "workflows/odd.ts": "export default 1;\n",
    });
    await expect(loadConfig(root)).rejects.toThrow(/\/workflows\/odd\.ts's default export is not a workflow: /);
  });
});
