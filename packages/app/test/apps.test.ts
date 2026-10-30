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
    // crm: taken, with its source; each name opens the app's page, where Update is.
    expect(taken).toMatch(/<a [^>]*href="\/apps\/crm"[^>]*>crm<\/a>/);
    expect(yours).toMatch(/<a [^>]*href="\/apps\/shop"[^>]*>shop<\/a>/);
    expect(taken).toContain("From <code>https://github.com/example/crm</code>");
    expect(taken).toContain('href="https://github.com/example/crm"');
    expect(taken).not.toContain(">Update<");
    expect(shown).toContain(">New app<");
  });

  it("shows an app's parts in one card, its sites, collections, workflows, policies and scenarios, never its people", async () => {
    const { status, html, shown } = await page("/apps/crm");
    expect(status).toBe(200);
    expect(html).toContain("<title>crm · Sanoma</title>");
    expect(html).toMatch(/<nav aria-label="Breadcrumb"[^>]*><ol[^>]*><li[^>]*><a [^>]*href="\/apps"[^>]*>Apps<\/a>/);
    expect(html).toMatch(/<h1[^>]*>crm<\/h1>/);
    // Apps stays lit on an app's page.
    expect(barLink(html, "/apps")).toContain('aria-current="page"');
    // Taken: its source and Update in the header.
    const header = shown.match(/<header[\s\S]*?<\/header>/)?.[0];
    expect(header).toContain('href="https://github.com/example/crm"');
    expect(header).toContain(">Update<");
    expect(shown).toContain("Taken from");
    const section = (title: string) =>
      shown.match(new RegExp(`<section aria-label="${title}"[\\s\\S]*?</section>`))?.[0];
    expect(shown).toMatch(
      /aria-label="Sites"[\s\S]*aria-label="Collections"[\s\S]*aria-label="Workflows"[\s\S]*aria-label="Policies"[\s\S]*aria-label="Scenarios"/,
    );
    // Its site, with what it calls (this build serves no site's pages, so its title is no link).
    expect(section("Sites")).toContain(">Pipeline<");
    expect(section("Sites")).toContain("/sites/crm/pipeline");
    expect(section("Sites")).toContain(">crm.customers</code>");
    // Its collection, opening the grid; never the shop's of the same name.
    expect(section("Collections")).toMatch(/<a [^>]*href="\/data\/crm\.customers"[^>]*>Customers<\/a>/);
    expect(section("Collections")).toContain("email, name, followedUp");
    expect(section("Collections")).not.toContain("shop.customers");
    // Its workflow, what it may call and its last run (never run here), and nothing of the root's.
    const workflows = section("Workflows")!;
    expect(workflows).toMatch(/<a [^>]*href="\/workflows\/crm\.follow-up"[^>]*>Follow up<\/a>/);
    expect(workflows).toContain(">data.crm.customers.save</code>");
    expect(workflows).toContain("Never run");
    expect(workflows).toContain('href="/workflows/crm.follow-up?view=runs"');
    expect(workflows).not.toContain("introduce");
    // Its policy file, with its rule's reason.
    const policies = section("Policies")!;
    expect(policies).toContain(">apps/crm/policies/crm.cedar</code>");
    expect(policies).toContain("1 rule");
    expect(policies).toContain("The CRM keeps every customer");
    // Its scenarios, by feature file.
    const scenarios = section("Scenarios")!;
    expect(scenarios).toContain(">apps/crm/scenarios/follow-up.feature</code>");
    expect(scenarios).toContain("2 scenarios");
    expect(scenarios).toContain('href="/workflows/crm.follow-up?view=scenarios"');
    // People are the root's.
    expect(shown).toContain("People are never inside an app");
  });

  it("shows the company's own app without a source or Update, and says so for what it lacks", async () => {
    const { status, shown } = await page("/apps/shop");
    expect(status).toBe(200);
    const header = shown.match(/<header[\s\S]*?<\/header>/)?.[0];
    expect(header).not.toContain(">Update<");
    expect(shown).toContain("The company&#x27;s own app");
    expect(shown).toMatch(/aria-label="Sites"[\s\S]*?None\./);
    expect(shown).toMatch(/aria-label="Policies"[\s\S]*?None\./);
    expect(shown).toMatch(/<a [^>]*href="\/workflows\/shop\.follow-up"[^>]*>Thank a customer<\/a>/);
  });

  it("says when no app has the name", async () => {
    const { status, html } = await page("/apps/nope");
    expect(status).toBe(404);
    expect(html).toContain("No app nope.");
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
  });
});

describe("Data by app", () => {
  it("groups the collections by the folder that declares them, with a tab each", async () => {
    const { status, html } = await page("/data");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Data<span[^>]*>2<\/span><\/h1>/);
    // All, then each app with collections (the root declares none here).
    const tabs = html.match(/<div[^>]*role="tablist"[^>]*aria-label="App"[\s\S]*?<\/div>/)?.[0];
    expect(tabs).toMatch(/href="\/data"[^>]*>All<span[^>]*>2<\/span>/);
    expect(tabs).toMatch(/href="\/data\?app=crm"[^>]*>crm<span[^>]*>1<\/span>/);
    expect(tabs).toMatch(/href="\/data\?app=shop"[^>]*>shop<span[^>]*>1<\/span>/);
    expect(tabs).not.toContain("Yours");
    // A heading per app, in the apps' order, a taken one with its source; each row under its own.
    expect(html).toMatch(
      /scope="colgroup"[^>]*>crm <span[^>]*>· apps\/crm, from https:\/\/github.com\/example\/crm<\/span>[\s\S]*href="\/data\/crm\.customers"[\s\S]*scope="colgroup"[^>]*>shop <span[^>]*>· apps\/shop<\/span>[\s\S]*href="\/data\/shop\.customers"/,
    );
    const row = (name: string) =>
      html.match(
        new RegExp(`<tr[^>]*><td[^>]*><div[^>]*><a [^>]*href="/data/${name}"[^>]*>(?:(?!</tr>)[\\s\\S])*</tr>`),
      )?.[0];
    // Written by: the workflows that save it (the root's introduce saves the CRM's), Shown on: the
    // sites that call it, Declared in: its file.
    const crm = row("crm\\.customers")!;
    expect(crm).toMatch(/href="\/workflows\/crm\.follow-up"[^>]*>Follow up<\/a>/);
    expect(crm).toMatch(/href="\/workflows\/introduce"[^>]*>Introduce a shop customer to the CRM<\/a>/);
    expect(crm).toContain(">Pipeline<");
    expect(crm).toContain(">apps/crm/resources/data.ts</a>");
    const shop = row("shop\\.customers")!;
    expect(shop).not.toContain('href="/workflows/');
    expect(shop).toContain(">apps/shop/resources/data.ts</a>");
  });

  it("shows one app's collections under its tab, without headings", async () => {
    const { html } = await page("/data?app=shop");
    expect(html).toMatch(
      /aria-selected="true"[^>]*href="\/data\?app=shop"|href="\/data\?app=shop"[^>]*aria-selected="true"/,
    );
    expect(html).toContain('href="/data/shop.customers"');
    expect(html).not.toContain('href="/data/crm.customers"');
    expect(html).not.toContain('scope="colgroup"');
    // An app with no collections shows them all.
    expect((await page("/data?app=nope")).html).toContain('href="/data/crm.customers"');
  });
});

describe("Workflows and Permissions by app", () => {
  it("groups the workflows by their folder, the root's first, with a tab each beside the filters", async () => {
    const { html } = await page("/workflows");
    const tabs = html.match(/<div[^>]*role="tablist"[^>]*aria-label="App"[\s\S]*?<\/div>/)?.[0];
    expect(tabs).toMatch(/href="\/workflows"[^>]*>All<span[^>]*>5<\/span>/);
    // The root holds introduce and the built-ins.
    expect(tabs).toMatch(/href="\/workflows\?app=\."[^>]*>Yours<span[^>]*>3<\/span>/);
    expect(tabs).toMatch(/href="\/workflows\?app=crm"[^>]*>crm<span[^>]*>1<\/span>/);
    expect(tabs).toMatch(/href="\/workflows\?app=shop"[^>]*>shop<span[^>]*>1<\/span>/);
    expect(html).toMatch(
      /scope="colgroup"[^>]*>Yours <span[^>]*>· the root<\/span>[\s\S]*href="\/workflows\/introduce"[\s\S]*scope="colgroup"[^>]*>crm <span[^>]*>· apps\/crm, from https:\/\/github.com\/example\/crm<\/span>[\s\S]*href="\/workflows\/crm\.follow-up"[\s\S]*scope="colgroup"[^>]*>shop [\s\S]*href="\/workflows\/shop\.follow-up"/,
    );
    // One app's, without headings; the filters count within it and keep it.
    const crm = (await page("/workflows?app=crm")).shown;
    expect(crm).toContain('href="/workflows/crm.follow-up"');
    expect(crm).not.toContain('href="/workflows/introduce"');
    expect(crm).not.toContain('scope="colgroup"');
    expect(crm).toMatch(/href="\/workflows\?filter=builtin&amp;app=crm"[^>]*>Built-in<span[^>]*>0<\/span>/);
    // An app of no workflows shows them all.
    expect((await page("/workflows?app=nope")).html).toContain('href="/workflows/introduce"');
  });

  it("scopes the policy's files and the grid's rows to an app's folder", async () => {
    // One folder holds policy files here, the CRM's: no tabs, no headings.
    const all = (await page("/permissions")).shown;
    expect(all).not.toMatch(/role="tablist"[^>]*aria-label="App"/);
    expect(all).toContain(">apps/crm/policies/crm.cedar<");
    expect(all).toContain('href="/workflows/introduce"');
    // The CRM's: its workflows and its collections' operations, not the root's or the shop's.
    const crm = (await page("/permissions?app=crm")).shown;
    expect(crm).toContain(">apps/crm/policies/crm.cedar<");
    expect(crm).toContain('href="/workflows/crm.follow-up"');
    expect(crm).not.toContain('href="/workflows/introduce"');
    expect(crm).not.toContain('href="/workflows/shop.follow-up"');
    expect(crm).not.toContain("data.shop.customers");
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

      // Update on the app taken's page: how far behind it is (this instance's repository cannot
      // fetch, so why not), then a new chat asking the agent to update it.
      await tab.goto(new URL("/apps/crm", app.url).href, { waitUntil: "networkidle0" });
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
