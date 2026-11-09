import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "sanoma/workflows";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "sanoma/workflows/shared";
import { loadConfig } from "../src/config.ts";
import { ensureSanomaBuilt } from "./fixture.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A company in a fresh directory: its files by path, and this checkout's `sanoma` installed. */
function company(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "sanoma-config-"));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(dir, "node_modules/sanoma"));
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

/** A helper file's text, exporting `title`. */
const title = (name: string) => `export const title = "${name}";\n`;

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

  it("reads the files as they are now with fresh, though this process imported them before", () => {
    const root = company({
      "sanoma.config.ts": CONFIG(),
      "workflows/named.ts":
        'import { defineWorkflow } from "sanoma";\nimport { title } from "./title.ts";\nexport default defineWorkflow({ name: title, trigger: "manual", uses: [], run: async () => ({}) });\n',
      "workflows/title.ts": title("welcome"),
    });
    // In Node itself: Vitest imports a module its own way, past Node's resolve hooks.
    ensureSanomaBuilt();
    const script = `
      import { writeFileSync } from "node:fs";
      import { resolveConfig } from "sanoma/workflows";
      const { loadConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
      const names = async (fresh) => (await loadConfig(process.cwd(), { fresh })).config.workflows.map((w) => w.name).toSorted();
      const seen = [await names(false)];
      writeFileSync("workflows/title.ts", ${JSON.stringify(title("onboard"))});
      writeFileSync("workflows/later.ts", ${JSON.stringify(workflow("later"))});
      seen.push(await names(false), await names(true));
      writeFileSync("workflows/title.ts", ${JSON.stringify(title("follow-up"))});
      const { config } = await loadConfig(process.cwd(), { fresh: true });
      seen.push(resolveConfig(config).workflows.has("follow-up"));
      console.log(JSON.stringify(seen));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual([
      ["welcome"],
      // Without fresh, a file imported before is the module it was.
      ["later", "welcome"],
      ["later", "onboard"],
      // And again, each fresh load its own.
      true,
    ]);
  });
});
