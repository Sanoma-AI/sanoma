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
  `import { allowAll, defineConfig } from "sanoma";\n${collections ? 'import { leads } from "./resources/data.ts";\n' : ""}` +
  `export default defineConfig({ workflows: [], connectors: [], policy: allowAll${collections} });\n`;
const DATA = `import { collection } from "sanoma/data";
export const leads = collection({ name: "leads", key: "id", fields: { id: "text" } });
export const deals = collection({ name: "deals", key: "id", fields: { id: "text", won: "boolean" } });
`;

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
});
