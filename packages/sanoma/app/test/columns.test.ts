import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { resolveConfig, type SanomaConfig } from "sanoma/workflows";
import { readPeople } from "sanoma/workflows/describe";
import { changeIdOf } from "sanoma/workflows/shared";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRemote, memorySource } from "../../workflows/test/fakes/remote.ts";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import type { ColumnChange } from "../src/components/grid/plan.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { proposeColumnChange } from "../src/server/columns.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { appSteps } from "../src/steps/index.ts";
import { pageOf, PEOPLE, publishOf } from "./fixtures/change.ts";
import { ensureSanomaBuilt } from "../../test/fixture.ts";

// Needs Postgres (`pnpm db:up`) and the built app, as data.test.ts does. A collection's columns
// from its grid, on a copy of the outbound fixture with a remote (C5's fake host over a repository
// in memory, `memorySource`) and the app's steps in the worker: each heading's column menu and New
// column, the column panel as the server renders it, a proposal landed as a change of its own
// (`proposeColumnChange`: a `patch` run's draft, its data file showing the new column, the change
// carrying its plan, a type change's decision for the values that won't convert among it) and
// that change's review in the table change's words; in Chrome, skipped without it, the menu
// opening the Rename panel and its What will happen, and the Change type panel, over a grid that
// loaded fewer records than there are, asking what becomes of every value that won't convert
// (the server's plan, not the rows on screen) before it sends the change.

const root = mkdtempSync(join(tmpdir(), "sanoma-columns-"));
cpSync(fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)), root, { recursive: true });
writeFileSync(join(root, "resources/people.ts"), PEOPLE);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const remote = fakeRemote();
const repo = memorySource({ root, remote });
afterAll(() => repo.remove());
const config: SanomaConfig = { workflows: [], connectors: [remote.connector], collections: [outbound], root };
const testApp = useTestApp(config, {
  databaseUrl: testDatabaseUrl("app_columns"),
  source: repo.source,
  app: appSteps,
});
let app: App;

beforeAll(async () => {
  ensureSanomaBuilt();
  app = await startApp(testApp.config, { port: 0, source: repo.source });
  for (const [company, contact] of [
    ["Acme Plumbing", "dana@acme.test"],
    ["Brightwater Dental", "sam@brightwater.test"],
  ]) {
    const record = { company, contact, stage: "researched", owner: "ada" };
    await testApp.client.call("data.outbound.save", { record }, { actor: { id: "ada" }, id: crypto.randomUUID() });
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
});

/** The app's context, as the server functions get it. */
const contextOf = async (): Promise<AppContext> => ({
  resolved: resolveConfig(testApp.config),
  snapshot: await appSnapshot(testApp.config, { source: repo.source }),
  client: testApp.client,
  place: "this-computer",
  login: admitting(loopbackLogin(), () => readPeople(root)),
});

/** The data page with the column panel open on `column`, as ada sees it. */
const panel = (column: Record<string, string>) =>
  pageOf(app, `/data/outbound?column=${encodeURIComponent(JSON.stringify(column))}`);

describe("a collection's columns", () => {
  it("puts a menu on each heading but the key's, and New column after the last", async () => {
    const { html } = await pageOf(app, "/data/outbound");
    const menus = [...html.matchAll(/aria-label="Change the column (\w+)"/g)].map(([, field]) => field);
    expect(menus).toEqual(["contact", "stage", "owner", "lastTouched", "seats"]);
    expect(html).toMatch(/<a [^>]*href="\/data\/outbound\?column=[^"]*add[^"]*"[^>]*>.*?New column<\/span><\/a>/);
  });

  it("draws the New column panel: Name, the type chips, Optional, What will happen, and Review the change", async () => {
    const { status, html } = await panel({ change: "add" });
    expect(status).toBe(200);
    expect(html).toContain('aria-label="New column in outbound"');
    expect(html).toMatch(/<input [^>]*id="column-name"/);
    const chips = [...html.matchAll(/<button ([^>]*aria-pressed="(?:true|false)"[^>]*)>([^<]+)<\/button>/g)].map(
      ([, attributes, label]) =>
        `${label}${attributes!.includes('aria-pressed="true"') ? " (on)" : ""}${/(^| )disabled=""/.test(attributes!) ? " (off)" : ""}`,
    );
    expect(chips).toEqual([
      "Text (on)",
      "Number",
      "Yes / no",
      "Date",
      "A person",
      "A choice",
      "Link to another table (off)",
      "Free-form (off)",
    ]);
    expect(html).toContain("existing records stay valid with it empty");
    // No name yet: What will happen says what is missing, and Review the change waits for it.
    expect(html).toContain("What will happen");
    expect(html).toContain("Letters, digits and _, not a digit first");
    expect(html).toMatch(/<button type="submit"[^>]*disabled[^>]*>Review the change<\/button>/);
    expect(html).toContain("Waits for admin");
  });

  it("draws the Rename panel with the name as it is, which changes nothing yet", async () => {
    const { html } = await panel({ change: "rename", field: "contact" });
    expect(html).toContain('aria-label="Rename contact"');
    expect(html).toMatch(/<input [^>]*id="column-name"[^>]*value="contact"/);
    expect(html).toContain("Nothing changes.");
  });

  it("proposes a new column as a change of its own: the draft's data file has it, and the change carries its plan", async () => {
    const context = await contextOf();
    const change: ColumnChange = {
      kind: "add",
      field: "priority",
      type: { enum: ["High", "Normal", "Low"] },
      required: false,
    };
    const landed = await proposeColumnChange(
      context,
      { id: "ada", groups: ["admin"] },
      { collection: "outbound", change },
    );
    expect(landed).toEqual({ change: expect.stringMatching(/^change:ui-[\da-f]{8}$/) });
    const runId = (landed as { change: string }).change;
    const id = changeIdOf(runId)!;
    // The draft's file, not the checkout's.
    const draft = await repo.source.draft!(id);
    expect(readFileSync(join(draft.root, "resources/data.ts"), "utf8")).toContain(
      'priority: { enum: ["High", "Normal", "Low"], optional: true },',
    );
    expect(readFileSync(join(root, "resources/data.ts"), "utf8")).not.toContain("priority");
    expect((await testApp.client.change(id))?.state.plan).toEqual({
      collection: "outbound",
      changes: [{ ...change, empty: 2 }],
      rows: 2,
    });

    // Its review: the table change's card, and its decision in the table change's words.
    await publishOf(testApp.client, runId);
    const { html } = await pageOf(app, `/changes/${id}`);
    expect(html).toContain("<h2>Add priority</h2>");
    expect(html).toContain("All 2 records show it empty.");
    expect(html).toContain("Approve and apply");
    expect(html).toContain("Choosing Send back closes the change.");
    await testApp.client.changeEvent(id, { kind: "close", by: "ada" }, { by: { id: "ada" } });
  });

  it("renames a column as a rename, its value kept under the new name, and refuses one the declaration cannot take", async () => {
    const context = await contextOf();
    const ada = { id: "ada", groups: ["admin"] };
    const landed = await proposeColumnChange(context, ada, {
      collection: "outbound",
      change: { kind: "rename", from: "lastTouched", to: "lastContact" },
    });
    const id = changeIdOf((landed as { change: string }).change)!;
    const text = readFileSync(join((await repo.source.draft!(id)).root, "resources/data.ts"), "utf8");
    expect(text).toContain('lastContact: { type: "date", optional: true },');
    expect(text).not.toContain("lastTouched");
    await publishOf(testApp.client, `change:${id}`);
    await testApp.client.changeEvent(id, { kind: "close", by: "ada" }, { by: { id: "ada" } });

    await expect(
      proposeColumnChange(context, ada, { collection: "outbound", change: { kind: "hide", field: "company" } }),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "company is the key, which names each record: it stays as it is" },
    });
  });

  it("carries a type change's decision for the values that won't convert on its plan, and its review says it", async () => {
    const landed = await proposeColumnChange(
      await contextOf(),
      { id: "ada", groups: ["admin"] },
      { collection: "outbound", change: { kind: "retype", field: "contact", to: "number", decision: "keep" } },
    );
    const runId = (landed as { change: string }).change;
    const id = changeIdOf(runId)!;
    expect((await testApp.client.change(id))?.state.plan).toMatchObject({
      changes: [{ kind: "retype", field: "contact", wontConvert: { count: 2 }, decision: "keep" }],
    });
    await publishOf(testApp.client, runId);
    const { html } = await pageOf(app, `/changes/${id}`);
    expect(html).toContain("Keeps 2 for fixing");
    expect(html).toContain("Chosen: keep them as they are.");
    await testApp.client.changeEvent(id, { kind: "close", by: "ada" }, { by: { id: "ada" } });
  });

  it("opens the Rename panel from a heading's menu in Chrome, saying what will happen", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await tab.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "ada"));
      await tab.goto(new URL("/data/outbound", app.url).href, { waitUntil: "networkidle0" });
      await (await tab.waitForSelector('button[aria-label="Change the column contact"]'))!.click();
      // Rename, Change type, Hide for me, Remove for everyone: no free-form field's keys on a text field.
      await tab.waitForFunction(
        `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((i) => i.firstChild.firstChild?.textContent ?? i.textContent).join() === "Rename,Change type,Hide for me,Remove for everyone…"`,
      );
      await (await tab.waitForSelector('[role="menuitem"]::-p-text(Rename)'))!.click();
      // The name as it is, to type over.
      await tab.waitForFunction(`document.querySelector("#column-name")?.value === "contact"`);
      await (await tab.$("#column-name"))!.click({ count: 3 });
      await tab.type("#column-name", "email");
      await tab.waitForSelector("[role=status]::-p-text(contact is called email from now on)");
      await tab.waitForFunction(
        `document.querySelector('[aria-label="Rename contact"] button[type="submit"]')?.disabled === false`,
      );
      expect(await tab.$('[aria-label="Rename contact"]')).not.toBeNull();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("asks in Chrome what becomes of every value a type change can't convert, not those on screen, then sends that choice", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await tab.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "ada"));
      // The grid loads one record of the two.
      await tab.goto(new URL("/data/outbound?limit=1", app.url).href, { waitUntil: "networkidle0" });
      // Its heading and one row.
      expect(await tab.evaluate(`document.querySelector('[role="grid"]').getAttribute("aria-rowcount")`)).toBe("2");
      await (await tab.waitForSelector('button[aria-label="Change the column contact"]'))!.click();
      await (await tab.waitForSelector('[role="menuitem"]::-p-text(Change type)'))!.click();
      await (await tab.waitForSelector("button[aria-pressed]::-p-text(Number)"))!.click();
      // Both emails can't be numbers, the one off screen too: the panel asks, and waits for the answer.
      await tab.waitForSelector("legend::-p-text(These 2 values can't convert to a number)");
      const submit = '[aria-label="Change the type of contact"] button[type="submit"]';
      expect(await tab.$(`${submit}[disabled]`)).not.toBeNull();
      await (await tab.waitForSelector("label::-p-text(Leave these 2 empty)"))!.click();
      await tab.waitForSelector("[role=status]::-p-text(they're left empty, and lose what they hold now)");
      await (await tab.waitForSelector(`${submit}:not([disabled])`))!.click();
      await tab.waitForFunction(`location.pathname.startsWith("/changes/ui-")`, { timeout: 30_000 });
      const id = new URL(tab.url()).pathname.slice("/changes/".length);
      expect((await testApp.client.change(id))?.state.plan).toMatchObject({
        changes: [{ kind: "retype", field: "contact", decision: "clear" }],
      });
      await testApp.client.changeEvent(id, { kind: "close", by: "ada" }, { by: { id: "ada" } });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
