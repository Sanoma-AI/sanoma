import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companyFiles, importMetaUrl, optional } from "sanoma/app/bundle";
import { afterAll, expect, it } from "vitest";
import { build, type Rolldown } from "vite";

// `sanoma/workflows/page` built for a browser, as a demo's build will, with a fixture page that
// declares a collection and a workflow calling Resend: what the page reaches holds nothing of
// Node, DBOS or a database, and it runs. Needs the built connectors, as the other builds' tests.
const fixture = fileURLToPath(new URL("./fixtures/page/", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "sanoma-page-bundle-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** What a page must never reach: Node's modules (Vite's browser stub for each), DBOS, Postgres's client, Drizzle. */
const FORBIDDEN = [
  /__vite-browser-external/,
  /[\\/]@dbos-inc[\\/]/,
  /[\\/]node_modules[\\/]pg[\\/]/,
  /[\\/]drizzle-orm[\\/]/,
];

it("builds a page's runtime for a browser without Node, DBOS or a database, and runs a workflow in it", async () => {
  const result = (await build({
    configFile: false,
    logLevel: "silent",
    root: fixture,
    plugins: [importMetaUrl({ vendorInfoOnly: true }), companyFiles(fixture, { fromRoot: true }), optional()],
    resolve: { conditions: ["sanoma-source", "browser", "module", "import", "default"] },
    build: {
      write: false,
      minify: false,
      lib: { entry: join(fixture, "entry.ts"), formats: ["es"], fileName: "page" },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunks = new Map(
    [result]
      .flat()
      .flatMap((o) => o.output)
      .filter((o): o is Rolldown.OutputChunk => o.type === "chunk")
      .map((c) => [c.fileName, c]),
  );
  // What the entry reaches, by static and dynamic imports: a chunk only tree-shaken code imported is emitted, never loaded.
  const reached = new Set<string>();
  const reach = (name: string) => {
    const chunk = chunks.get(name);
    if (!chunk || reached.has(name)) return;
    reached.add(name);
    for (const next of [...chunk.imports, ...chunk.dynamicImports]) reach(next);
  };
  for (const chunk of chunks.values()) if (chunk.isEntry) reach(chunk.fileName);
  const modules = [...reached].flatMap((name) => chunks.get(name)!.moduleIds);
  expect(modules.some((m) => m.endsWith(join("workflows", "src", "page-run.ts")))).toBe(true);
  expect(modules.filter((m) => FORBIDDEN.some((f) => f.test(m)))).toEqual([]);
  // Nothing left for the browser to import: every module is in the build.
  expect([...reached].flatMap((name) => chunks.get(name)!.imports.filter((i) => !chunks.has(i)))).toEqual([]);

  for (const chunk of chunks.values()) writeFileSync(join(out, chunk.fileName), chunk.code);
  const entry = [...chunks.values()].find((c) => c.isEntry)!;
  const { page } = (await import(pathToFileURL(join(out, entry.fileName)).href)) as {
    page: Promise<{ transport(request: { name: string; input?: unknown }): Promise<unknown> }>;
  };
  const { transport } = await page;
  const before = Date.now();
  const { runId } = (await transport({ name: "sendInvoice", input: { number: "INV-1" } })) as { runId: string };
  const { id, at } = (await transport({ name: "sendInvoice.result", input: { runId } })) as { id: string; at: number };
  expect(id).toEqual(expect.any(String));
  expect(at).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
});
