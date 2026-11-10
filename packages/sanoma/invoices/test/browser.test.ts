import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderInvoice } from "sanoma/invoices/pdf";
import { build, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { content, example } from "./helpers.ts";

// `sanoma/invoices/pdf` as a site's browser bundle has it: built by Vite for the browser, which
// takes React-pdf's browser build (its `browser` field), with nothing of Node's in it. The bundle
// then renders the invoice the Node build does, page for page.
const out = mkdtempSync(join(tmpdir(), "sanoma-invoice-browser-"));
let modules: string[] = [];
let browserRender: typeof renderInvoice;

beforeAll(async () => {
  const result = (await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      lib: { entry: fileURLToPath(new URL("../src/pdf.ts", import.meta.url)), formats: ["es"], fileName: "pdf" },
    },
  })) as Rollup.RollupOutput[];
  modules = result.flatMap(({ output }) => output.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])));
  ({ renderInvoice: browserRender } = await import(pathToFileURL(join(out, "pdf.js")).href));
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("invoice PDF in a browser build", () => {
  it("bundles React-pdf's browser build and nothing of Node's", () => {
    expect(modules.some((id) => id.includes("@react-pdf/renderer/lib/react-pdf.browser.js"))).toBe(true);
    expect(modules.filter((id) => id.includes("__vite-browser-external") || id.startsWith("node:"))).toEqual([]);
  });

  it("renders the invoice the Node build does", async () => {
    const invoice = example();
    invoice.lines = Array.from({ length: 40 }, (_, i) => ({ ...invoice.lines[0]!, description: `Service ${i + 1}` }));
    const [browser, node] = await Promise.all([browserRender(invoice), renderInvoice(invoice)]);
    expect(browser.summary).toEqual(node.summary);
    expect(browser.filename).toBe(node.filename);
    expect(await content(browser.bytes)).toEqual(await content(node.bytes));
  });
});
