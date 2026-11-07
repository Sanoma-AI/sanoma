import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { executablePath, launch } from "puppeteer-core";
import { escapeIdentifier, Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { memorySecretStore, SanomaClient, type SanomaConfig, startWorker } from "sanoma/workflows";
import { startApp } from "../src/index.ts";
import { ensureSanomaBuilt } from "../../test/fixture.ts";

// Needs Postgres and Chrome. The Secret storage panel's Move, in a browser: the plan, the start,
// the paused writes and the switch to make; then, on the code that selects the destination, the
// run's cutover and retirement as the panel shows them. No value reaches the page.

const SENTINEL = `plaintext-sentinel-${randomUUID()}`;
const databaseUrl = testDatabaseUrl("app_store_move");
const other = memorySecretStore();
const bindings = { PLAIN: { path: "plain/value", management: "sanoma" } } as const;
const before: SanomaConfig = {
  databaseUrl,
  connectors: [],
  secrets: { namespace: "live", bindings, stores: { vault: { store: other, namespace: "live" } } },
};
const after: SanomaConfig = {
  databaseUrl,
  connectors: [],
  secrets: { store: other, namespace: "live", bindings, stores: { builtin: { namespace: "live" } } },
};

beforeAll(async () => {
  const server = new URL(databaseUrl);
  server.pathname = "/postgres";
  const admin = new Pool({ connectionString: server.toString() });
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${escapeIdentifier(new URL(databaseUrl).pathname.slice(1))} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
});

/** The app, a worker and a signed-in page on `config` for the length of `use`. */
async function onPage(
  config: SanomaConfig,
  chrome: string,
  use: (page: import("puppeteer-core").Page) => Promise<void>,
) {
  const worker = await startWorker(config);
  const server = await startApp(config, { port: 0 });
  const browser = await launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });
    await page.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "alice"));
    await page.goto(new URL("/connectors", server.url).href);
    await use(page);
    expect(await page.content()).not.toContain(SENTINEL);
  } finally {
    await browser.close();
    await server.close();
    await worker.stop();
  }
}
const text = (page: import("puppeteer-core").Page, wanted: string) =>
  page.waitForFunction(`document.body.textContent.includes(${JSON.stringify(wanted)})`, { timeout: 30_000 });

describe("the Secret storage panel's Move", () => {
  it("plans and starts a move, shows the pause and the switch, then the cutover and retirement", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    ensureSanomaBuilt();
    const client = await SanomaClient.connect(before);
    try {
      await client.setSecret("PLAIN", SENTINEL, { by: "alice" });
    } finally {
      await client.close();
    }

    await onPage(before, chrome, async (page) => {
      // Hydrated: the moves are read in the browser, as the signed-in actor.
      await page.waitForSelector("#move-to");
      await text(page, "Store access checked");
      expect(await page.evaluate(`document.querySelector("#move-to").value`)).toBe("vault");
      await page.click("#move-retain", { count: 3 });
      await page.type("#move-retain", "0");
      await page.click("button::-p-text(Review plan)");
      await text(page, "1 secret to copy");
      const plan = await page.evaluate(`document.querySelector('[aria-label="Plan"]').textContent`);
      expect(plan).toContain("PLAIN");
      expect(plan).toContain("Copy");
      expect(plan).toContain(`${SENTINEL.length} B`);
      await page.click("button::-p-text(Start move)");
      await text(page, "Copies verified");
      await text(page, "Writes to the current store are paused");
      const panel = await page.evaluate(`document.querySelector('[aria-label="Store move"]').textContent`);
      expect(panel).toContain("1 of 1");
      expect(panel).toContain("sanoma.config.ts");
      expect(panel).toContain("Cancel move");
      await page.screenshot({ path: "/tmp/store-move-waiting.png", fullPage: true });
    });

    // The reviewed change deploys: the code selects the destination, and the run cuts over.
    await onPage(after, chrome, async (page) => {
      await page.waitForFunction(`document.body.textContent.includes("Done · old copies retired")`, {
        timeout: 90_000,
      });
      const panel = await page.evaluate(`document.querySelector('[aria-label="Store move"]').textContent`);
      expect(panel).toContain("Switched");
      expect(panel).toContain("retired");
      // A finished move offers the next one.
      await page.waitForSelector("#move-to");
      await page.screenshot({ path: "/tmp/store-move-retired.png", fullPage: true });
    });
    const switched = await SanomaClient.connect(after);
    try {
      await waitFor(async () => (await switched.secrets(["PLAIN"])).get("PLAIN")?.value === SENTINEL);
    } finally {
      await switched.close();
    }
  }, 240_000);
});
