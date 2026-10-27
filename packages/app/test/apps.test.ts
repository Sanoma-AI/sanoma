import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { memoryLedger, type SanomaConfig, type Source } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { APPS_LIST, type AvailableApps } from "@sanoma-ai/workflows/shared";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../../workflows/test/fixtures/company-apps/sanoma.config.ts";
import { customers as crmCustomers } from "../../workflows/test/fixtures/company-apps/apps/crm/resources/data.ts";
import { customers as shopCustomers } from "../../workflows/test/fixtures/company-apps/apps/shop/resources/data.ts";
import followUp from "../../workflows/test/fixtures/company-apps/apps/crm/workflows/follow-up.ts";
import thank from "../../workflows/test/fixtures/company-apps/apps/shop/workflows/follow-up.ts";
import introduce from "../../workflows/test/fixtures/company-apps/workflows/introduce.ts";
import { ACTOR_COOKIE, ACTOR_KEY } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { takeAppPrompt, updateAppPrompt } from "../src/lib/apps.ts";
import { appBehind } from "../src/server/core.ts";
import { barLink } from "./bar-helpers.ts";

// Needs Postgres (`pnpm db:up`) and the built app (built when stale). The Apps page on the
// company-apps fixture (crm taken from a source, shop the company's own), GitHub's search mocked
// with msw; and the chat a page opens with a prompt (New app, Add, Update, New workflow), in Chrome,
// skipped without it (or `CHROME_PATH`).

const appDir = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../workflows/test/fixtures/company-apps/", import.meta.url));

// The fixture's workflows and collections, as the launcher finds them (`loadConfig`).
const config: SanomaConfig = {
  ...fixture,
  workflows: [followUp, thank, introduce],
  collections: [crmCustomers, shopCustomers],
  root,
  ledger: memoryLedger(),
};

const GITHUB_API = "https://api.github.com";

/** GitHub's search for the topic: Sanoma's portal, the CRM the fixture took, and someone's inventory. */
const github = setupServer(
  http.get(`${GITHUB_API}/search/repositories`, () =>
    HttpResponse.json({
      items: ["someone/inventory", "example/crm", "Sanoma-AI/tenant-portal"].map((name) => ({
        full_name: name,
        html_url: `https://github.com/${name}`,
        description: name === "someone/inventory" ? "Stock and orders" : null,
        license: { spdx_id: "MIT" },
      })),
    }),
  ),
);

const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("app_apps") });
let app: App;

beforeAll(async () => {
  github.listen({ onUnhandledFrame: "bypass" });
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(testApp.config, { port: 0 });
}, 120_000);

afterAll(async () => {
  github.close();
  await app?.close();
});

/** A page as the server renders it for `actor` (the loopback login's cookie), the HTML it shows (no scripts). */
async function page(path: string, actor = "ada") {
  const res = await fetch(new URL(path, app.url), { headers: { cookie: `${ACTOR_COOKIE}=${actor}` } });
  const html = (await res.text()).replaceAll("<!-- -->", "");
  return { status: res.status, html, shown: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "") };
}

describe("the Apps page", () => {
  it("lists the company's own apps, and those taken with their source", async () => {
    const { status, html, shown } = await page("/apps");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Apps<span[^>]*>2<\/span><\/h1>/);
    expect(html).toContain("<title>Apps · Sanoma</title>");
    expect(barLink(html, "/apps")).toContain('aria-current="page"');
    expect(shown).toMatch(/<h2[^>]*>Yours<\/h2>[\s\S]*<h2[^>]*>Taken<\/h2>[\s\S]*<h2[^>]*>Available<\/h2>/);
    const [yours, taken] = shown.split(/<h2[^>]*>/).slice(1);
    // shop: the company's own, with what it holds.
    expect(yours).toContain(">shop<");
    expect(yours).toContain("apps/shop");
    expect(yours).toContain("1 workflow · 1 collection · 0 sites");
    expect(yours).not.toContain(">crm<");
    // crm: taken, with its source.
    expect(taken).toContain(">crm<");
    expect(taken).toContain("From <code>https://github.com/example/crm</code>");
    expect(taken).toContain('href="https://github.com/example/crm"');
    expect(taken).toContain(">Update<");
    expect(shown).toContain(">New app<");
  });

  it("tells how far a taken app is behind its source, or why it cannot", async () => {
    const description = describeConfig(testApp.config);
    // Only `behind` is read.
    const behind = (folder: string, source?: Pick<Source, "behind">) =>
      appBehind({ description, source: source as Source | undefined }, folder);
    const fetched = { behind: async (folder: string) => (folder === "crm" ? 3 : 0) };
    expect(await behind("crm", fetched)).toEqual({ behind: 3 });
    expect(await behind("shop", fetched)).toEqual({ error: "No app apps/shop/ taken from a source" });
    expect(await behind("crm")).toEqual({ error: "This instance's repository cannot fetch an app's source" });
    const offline = { behind: () => Promise.reject(new Error("git fetch from https://github.com/example/crm failed")) };
    expect(await behind("crm", offline)).toEqual({ error: "git fetch from https://github.com/example/crm failed" });
  });

  it("reads GitHub's apps through sanoma.apps.list, as the person, under the policy", async () => {
    const listed = (await testApp.client.call(APPS_LIST, {}, { actor: { id: "ada" } })) as AvailableApps;
    expect(listed.apps.map((a) => [a.repo, a.tier])).toEqual([
      ["Sanoma-AI/tenant-portal", "official"],
      ["example/crm", "community"],
      ["someone/inventory", "community"],
    ]);
    github.use(http.get(`${GITHUB_API}/search/repositories`, () => new HttpResponse(null, { status: 403 })));
    try {
      expect(await testApp.client.call(APPS_LIST, {}, { actor: { id: "ada" } })).toEqual({
        apps: [],
        error: "Could not search GitHub: api.github.com answered 403 to /search/repositories",
      });
    } finally {
      github.resetHandlers();
    }
  });
});

describe("a prompt in the chat", () => {
  it("is what New app, Add, Update and New workflow open the chat with, in Chrome", async (test) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) test.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    // Wide enough for the chat column beside the page.
    const browser = await launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1280, height: 800 },
    });
    try {
      const tab = await browser.newPage();
      await tab.goto(new URL("/apps", app.url).href);
      await tab.evaluate((key) => localStorage.setItem(key, "ada"), ACTOR_KEY);
      // Folded, so New app has to open it.
      await tab.setCookie({ name: "sanoma_chat", value: "closed", url: app.url });
      await tab.goto(new URL("/apps", app.url).href, { waitUntil: "networkidle0" });
      expect(await tab.$("aside#chat")).toBeNull();
      // In the page, as strings: this file is typed for Node, without the DOM's globals.
      const composer = () =>
        tab.evaluate(`(() => {
          const box = document.querySelector("aside#chat textarea");
          return box && { value: box.value, focused: document.activeElement === box, caret: box.selectionStart };
        })()`) as Promise<{ value: string; focused: boolean; caret: number } | null>;
      const click = (label: string, within = "main") =>
        tab.evaluate(
          `[...document.querySelectorAll(${JSON.stringify(`${within} button`)})].find((b) => b.textContent === ${JSON.stringify(label)}).click()`,
        );
      const lands = async (text: string) => {
        await tab.waitForFunction(`document.querySelector("aside#chat textarea")?.value === ${JSON.stringify(text)}`);
        expect(await composer()).toEqual({ value: text, focused: true, caret: text.length });
      };

      await click("New app");
      await lands("Make an app that ");
      // A new chat, not sent: nothing in its transcript yet.
      expect(await tab.$eval("aside#chat", (aside) => aside.textContent)).toContain("New chat");
      expect(await tab.evaluate(`document.cookie`)).toContain("sanoma_chat=open");

      // The apps on GitHub, read once the page knows who you are: Sanoma's first, the one taken
      // left out, each with its README and Add.
      await tab.waitForFunction(`[...document.querySelectorAll("main button")].some((b) => b.textContent === "Add")`);
      const available = (await tab.evaluate(
        `document.querySelector("main section:last-of-type").innerHTML.replaceAll("<!-- -->", "")`,
      )) as string;
      expect(available).toMatch(
        />Sanoma-AI\/tenant-portal<[\s\S]*>Official<[\s\S]*>someone\/inventory<[\s\S]*>Community</,
      );
      expect(available).not.toContain("example/crm");
      expect(available).toContain("Stock and orders · MIT");
      expect(available).toContain('href="https://github.com/someone/inventory#readme"');
      expect(available.match(/>Add</g)).toHaveLength(2);
      // Add on one: a new chat again, with its URL.
      await tab.evaluate(
        `[...document.querySelectorAll("main [role=listitem]")].find((item) => item.textContent.includes("someone/inventory")).querySelector("button").click()`,
      );
      await lands(takeAppPrompt("https://github.com/someone/inventory"));

      // Update on the app taken: how far behind it is (this instance's repository cannot fetch, so
      // why not), then a new chat asking the agent to update it.
      await tab.waitForFunction(`document.querySelector("main").textContent.includes("cannot fetch an app's source")`);
      await click("Update");
      await lands(updateAppPrompt("crm"));

      // New workflow on the Workflows page, as it was a dialog before.
      await tab.goto(new URL("/workflows", app.url).href, { waitUntil: "networkidle0" });
      await click("New workflow");
      await lands("Make a workflow that ");
    } finally {
      await browser.close();
    }
  });
});
