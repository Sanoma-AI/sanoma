import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "puppeteer-core";
import { build, preview } from "vite";
import tailwind from "@tailwindcss/vite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = fileURLToPath(new URL("../test/invoice-editor-browser", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "sanoma-invoice-editor-"));
const output = resolve(process.argv[2] ?? join(tmpdir(), "sanoma-invoice-editor-proof"));
mkdirSync(output, { recursive: true });
let server, browser, page;
const errors = [],
  requests = [];
try {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [tailwind()],
    build: { outDir: temporary, emptyOutDir: true },
    resolve: {
      alias: [
        {
          find: /^@sanoma-ai\/invoices\/pdf-contract$/,
          replacement: fileURLToPath(new URL("../../invoices/src/render-contract.ts", import.meta.url)),
        },
        {
          find: /^@sanoma-ai\/invoices\/browser$/,
          replacement: fileURLToPath(new URL("../test/invoice-editor-browser/render.js", import.meta.url)),
        },
        {
          find: /^@sanoma-ai\/invoices\/examples$/,
          replacement: fileURLToPath(new URL("../../invoices/src/examples.ts", import.meta.url)),
        },
        {
          find: /^@sanoma-ai\/invoices$/,
          replacement: fileURLToPath(new URL("../../invoices/src/index.ts", import.meta.url)),
        },
      ],
    },
  });
  server = await preview({
    root,
    configFile: false,
    logLevel: "warn",
    build: { outDir: temporary },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await launch({
    channel: "chrome",
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: process.env.CI ? ["--no-sandbox"] : [],
  });
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const allowed =
      request.url().startsWith(origin) ||
      request.url().startsWith("data:") ||
      request.url().startsWith("blob:") ||
      request.url().startsWith("chrome://") ||
      request.url().startsWith("chrome-untrusted://") ||
      request.url().startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/");
    if (!allowed || request.method() !== "GET" || request.postData()) {
      requests.push({ url: request.url(), method: request.method() });
      void request.abort();
    } else void request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Device persistence attempted");
    };
    IDBFactory.prototype.open = () => {
      throw new Error("IndexedDB attempted");
    };
    window.objectUrls = new Set();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.objectUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.objectUrls.delete(url);
      revoke(url);
    };
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(origin, { waitUntil: "networkidle0" });
  const ready = () =>
    page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "PDF is up to date");
  const fill = async (name, value) =>
    page.evaluate(
      (fieldName, fieldValue) => {
        const input = document.getElementsByName(fieldName)[0];
        const prototype =
          input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, fieldValue);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      name,
      value,
    );
  const download = async () => {
    const count = await page.evaluate(() => window.invoiceDownloads.length);
    await page.click('button[type="submit"]');
    await page.waitForFunction((previousCount) => window.invoiceDownloads.length > previousCount, {}, count);
    return page.evaluate(() => window.invoiceDownloads.at(-1));
  };
  async function pdf(file, name) {
    const bytes = new Uint8Array(file.bytes);
    writeFileSync(join(output, `${name}.pdf`), bytes);
    const task = getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 });
    const document = await task.promise;
    try {
      const texts = [];
      for (let i = 1; i <= document.numPages; i++)
        texts.push((await (await document.getPage(i)).getTextContent()).items.map((item) => item.str ?? "").join(" "));
      return { pages: document.numPages, text: texts.join(" ") };
    } finally {
      await task.destroy();
    }
  }
  await ready();
  assert.equal((await download()).summary.totalMinor, 18000);
  await new Promise((done) => setTimeout(done, 1000));
  await page.screenshot({ path: join(output, "pet-desktop.png") });
  // Simulate native autofill/input events, then download immediately, before the debounce finishes.
  await fill("issuer.name", "Autofilled Pet Care");
  await fill("services[0].unitPrice", "30");
  const edited = await download();
  assert.equal(edited.summary.totalMinor, 20500);
  assert((await pdf(edited, "edited-pet")).text.includes("Autofilled Pet Care"));
  await fill("services[0].unitPrice", "");
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled);
  assert(await page.$('object[type="application/pdf"]'), "Retain the previous valid preview");
  await fill("services[0].unitPrice", "30");
  await ready();
  const add = await page.$("button::-p-text(Add a service)");
  await add.click();
  assert.equal(await page.$$eval('input[name$=".unitPrice"]', (fields) => fields.length), 4);
  await page.click('[aria-label="Remove service 2"]');
  assert.equal(await page.$eval('[name="services[1].unitPrice"]', (input) => input.value), "15");
  await page.click('[aria-label="Remove service 3"]');
  await ready();

  // Force two actual PDF renders to finish out of order, then inspect the visible PDF bytes.
  await page.evaluate(() => {
    window.invoiceRenderDelays = [1000, 0];
  });
  await fill("number", "OLD-REVISION");
  await page.waitForFunction(() =>
    window.invoiceRenderEvents.some((event) => event.number === "OLD-REVISION" && event.event === "started"),
  );
  await fill("number", "LATEST-REVISION");
  await ready();
  await page.waitForFunction(() =>
    window.invoiceRenderEvents.some((event) => event.number === "OLD-REVISION" && event.event === "finished"),
  );
  const visible = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await fetch(document.querySelector("object").data.split("#")[0])).arrayBuffer())),
  );
  const visiblePdf = await pdf({ bytes: visible }, "latest-preview");
  assert(visiblePdf.text.includes("LATEST-REVISION") && !visiblePdf.text.includes("OLD-REVISION"));

  await page.click('[data-example="home"]');
  await ready();
  const home = await download();
  assert.equal(home.summary.totalMinor, 24000);
  await pdf(home, "home");
  await new Promise((done) => setTimeout(done, 1000));
  await page.screenshot({ path: join(output, "cleaning-desktop.png") });
  await page.click('[data-example="office"]');
  await ready();
  const office = await pdf(await download(), "office");
  assert(office.text.includes("20 Billing Avenue") && office.text.includes("30 Office Street"));

  // A logo is read locally; invalid assets block downloading until removed.
  await page.evaluate(
    () =>
      ([...document.querySelectorAll("details")].find(
        (node) => node.querySelector("summary")?.textContent === "PDF appearance",
      ).open = true),
  );
  writeFileSync(join(temporary, "bad.png"), "not a PNG");
  await (await page.$('input[type="file"]')).uploadFile(join(temporary, "bad.png"));
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled);
  await page.click("button::-p-text(Remove logo)");
  await ready();
  const logo = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR4XmNYAAVwBgBaEgoBUJQjEgAAAABJRU5ErkJggg==";
  // A valid, bounded RGBA PNG used by the renderer's browser smoke fixture.
  writeFileSync(join(temporary, "logo.png"), Buffer.from(logo, "base64"));
  await (await page.$('input[type="file"]')).uploadFile(join(temporary, "logo.png"));
  await ready();
  await pdf(await download(), "logo");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.click('[data-example="home"]');
  await ready();
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No horizontal overflow on mobile",
  );
  await page.$eval('object[type="application/pdf"]', (node) => node.scrollIntoView());
  await new Promise((done) => setTimeout(done, 1500));
  await page.screenshot({ path: join(output, "cleaning-mobile-preview.png") });
  await page.screenshot({ path: join(output, "cleaning-mobile.png"), fullPage: true });
  await page.focus('[name="issuer.name"]');
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "issuer.email");
  await page.click('[data-example="long"]');
  await ready();
  assert((await pdf(await download(), "multipage")).pages > 1);

  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, "pdfViewerEnabled", { value: false }));
  await page.reload({ waitUntil: "networkidle0" });
  await ready();
  assert.equal(await page.$('object[type="application/pdf"]'), null);
  assert.equal((await download()).summary.totalMinor, 18000);
  await page.click("[data-unmount]");
  assert.equal(await page.evaluate(() => window.objectUrls.size), 0, "Object URLs released on unmount");
  await page.click('[data-example="blank"]');
  assert.equal(await page.$eval('[name="issuer.name"]', (input) => input.value), "");
  await fill("issuer.name", "New business");
  await fill("recipient.name", "New client");
  await fill("pets", "Milo");
  await fill("number", "NEW-001");
  await fill("issuedOn", "2026-10-30");
  await fill("services[0].unitPrice", "25");
  await ready();
  assert.equal((await download()).summary.totalMinor, 2500);
  await page.click('[data-example="failed"]');
  await ready();
  await page.click('button[type="submit"]');
  await page.waitForFunction(() =>
    document.body.innerText.includes("The PDF is ready, but the download did not complete"),
  );
  await page.click('[data-example="native"]');
  await ready();
  assert(await page.evaluate(() => document.body.innerText.includes("Nothing is uploaded or saved by this tool")));
  const downloadPath = join(temporary, "downloads");
  mkdirSync(downloadPath);
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath, eventsEnabled: true });
  const completed = new Promise((resolveDownload, rejectDownload) => {
    const timeout = setTimeout(() => rejectDownload(new Error("Native download timed out")), 15_000);
    cdp.on("Browser.downloadProgress", (event) => {
      if (event.state === "completed") {
        clearTimeout(timeout);
        resolveDownload();
      }
    });
  });
  await page.click('button[type="submit"]');
  await completed;
  const nativePdf = await pdf(
    { bytes: Array.from(readFileSync(join(downloadPath, "invoice-PET-001.pdf"))) },
    "native-download",
  );
  assert(nativePdf.text.includes("Clover Pet Care"));
  await cdp.detach();
  await page.click("[data-unmount]");
  assert.equal(await page.evaluate(() => window.objectUrls.size), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    JSON.stringify({
      output,
      checks:
        "current download, native input events, arrays, errors, logos, mobile, keyboard, multipage, unavailable viewer, URL cleanup, no storage or document requests",
    }),
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") });
    writeFileSync(
      join(output, "failure.json"),
      JSON.stringify({ errors, requests, text: await page.evaluate(() => document.body.innerText) }, null, 2),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  rmSync(temporary, { recursive: true, force: true });
}
