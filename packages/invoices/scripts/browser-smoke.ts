// Packs the package, bundles a consumer without source aliases, and compares real Chrome/Node PDFs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "puppeteer-core";
import { build, preview } from "vite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { renderInvoice } from "../src/node.ts";
import type { cases } from "../test/browser/main.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "sanoma-invoice-smoke-"));
const output = resolve(process.argv[2] ?? join(tmpdir(), "sanoma-invoice-evidence"));
mkdirSync(output, { recursive: true });

async function pages(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 });
  const document = await task.promise;
  try {
    const result = [];
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const content = await page.getTextContent();
      result.push({
        width: page.view[2],
        height: page.view[3],
        text: content.items.flatMap((item) => ("str" in item ? [item.str] : [])).join(" "),
      });
    }
    return result;
  } finally {
    await task.destroy();
  }
}

try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporary], { cwd: packageDir, stdio: "inherit" });
  const archive = readdirSync(temporary).find((name) => name.endsWith(".tgz"));
  assert(archive);
  execFileSync("tar", ["-xzf", join(temporary, archive), "-C", temporary]);
  // Only dependencies are shared. Every invoice module comes from the extracted archive.
  symlinkSync(join(packageDir, "node_modules"), join(temporary, "package/node_modules"));
  const consumer = join(temporary, "consumer");
  cpSync(join(packageDir, "test/browser"), consumer, { recursive: true });
  mkdirSync(join(consumer, "node_modules/@sanoma-ai"), { recursive: true });
  symlinkSync(join(temporary, "package"), join(consumer, "node_modules/@sanoma-ai/invoices"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const bundle = await build({
    root: consumer,
    configFile: false,
    logLevel: "warn",
    build: { minify: true },
    plugins: [
      {
        name: "reject-node-imports",
        generateBundle(_, chunks) {
          for (const chunk of Object.values(chunks))
            if (chunk.type === "chunk")
              assert(
                !chunk.moduleIds.some((id) => id.includes("__vite-browser-external") || id.startsWith("node:")),
                "Browser bundle includes a Node-only module",
              );
        },
      },
    ],
  });
  const chunks = Array.isArray(bundle)
    ? bundle.flatMap((result) => result.output)
    : "output" in bundle
      ? bundle.output
      : [];
  const javascriptBytes = chunks.reduce(
    (sum, chunk) => sum + (chunk.type === "chunk" ? Buffer.byteLength(chunk.code) : 0),
    0,
  );
  const server = await preview({
    root: consumer,
    configFile: false,
    preview: { host: "127.0.0.1", port: 0, open: false },
  });
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await launch({
    channel: "chrome",
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: process.env.CI ? ["--no-sandbox"] : [],
  }).catch(async (error: unknown) => {
    await server.close();
    throw error;
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [],
      external: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (!request.url().startsWith(url) && !request.url().startsWith("data:")) {
        external.push(request.url());
        void request.abort();
      } else void request.continue();
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof window.invoiceSmoke === "function");
    const packed = (await import(pathToFileURL(join(temporary, "package/dist/node.js")).href)) as {
      renderInvoice: typeof renderInvoice;
    };
    const measurements = [];
    for (const mode of ["desktop", "mobile-emulation"] as const) {
      await page.setViewport(
        mode === "desktop"
          ? { width: 1440, height: 900 }
          : { width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 },
      );
      await page.emulateCPUThrottling(mode === "desktop" ? 1 : 4);
      const results = await page.evaluate(() => window.invoiceSmoke());
      for (const [index, result] of results.entries()) {
        const input = result.input as (typeof cases)[number];
        const start = performance.now();
        const node = await packed.renderInvoice(input, result.options);
        const nodeMilliseconds = performance.now() - start;
        const browserBytes = Uint8Array.from(result.bytes);
        const browserPages = await pages(browserBytes);
        assert.deepEqual(browserPages, await pages(node.bytes), "Browser/Node content or pagination differs");
        assert.deepEqual(result.summary, node.summary);
        assert.equal(result.filename, node.filename);
        writeFileSync(join(output, `${mode}-${index + 1}.pdf`), browserBytes);
        measurements.push({
          mode,
          case: index + 1,
          browserMilliseconds: Math.round(result.milliseconds),
          nodeMilliseconds: Math.round(nodeMilliseconds),
          bytes: browserBytes.length,
          pages: browserPages.length,
        });
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "Rendering fetched an external asset");
    writeFileSync(join(output, "measurements.json"), JSON.stringify({ javascriptBytes, measurements }, null, 2));
    console.log(JSON.stringify({ javascriptBytes, measurements, output }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
