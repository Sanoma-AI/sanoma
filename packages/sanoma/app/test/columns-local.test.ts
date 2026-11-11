import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { collection } from "sanoma/data";
import { resolveConfig, type SanomaConfig, type Source } from "sanoma/workflows";
import { readPeople } from "sanoma/workflows/describe";
import { and, eq } from "drizzle-orm";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lazyDb } from "../../workflows/src/db.ts";
import { data } from "../../workflows/src/db/company.ts";
import type { AppContext } from "../src/context.ts";
import { type App, startApp } from "../src/index.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { proposeColumnChange } from "../src/server/columns.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { appSteps } from "../src/steps/index.ts";
import { pageOf, PEOPLE } from "./fixtures/change.ts";
import { ensureSanomaBuilt } from "../../test/fixture.ts";

// Needs Postgres (`pnpm db:up`) and the built app, as data.test.ts does. A collection's columns
// on a repository with no remote (a stub source that commits), so a column change is written in
// the checkout and the records follow it at once: a rename moves their values, a type change
// leaves empty the values that won't convert when that is the choice, and `patch`'s output says
// what became of them. The outbound fixture's collection, with a hidden field (`notes`), which
// the grid and the record form leave out and an edit keeps. The tests in a browser need Google
// Chrome, or `CHROME_PATH`, and skip without either.

const FIELDS = {
  company: "text",
  contact: "text",
  stage: { enum: ["researched", "contacted", "replied", "meeting", "won", "lost"] },
  owner: "person",
  lastTouched: { type: "date", optional: true },
  seats: { type: "number", optional: true },
  notes: { type: "text", optional: true, hidden: true },
} as const;
/** The collection the data file declares, as the worker runs it. */
const outbound = collection({ name: "outbound", title: "Outbound", key: "company", fields: FIELDS });

const root = mkdtempSync(join(tmpdir(), "sanoma-columns-local-"));
cpSync(fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)), root, { recursive: true });
writeFileSync(join(root, "resources/people.ts"), PEOPLE);
writeFileSync(
  join(root, "resources/data.ts"),
  readFileSync(join(root, "resources/data.ts"), "utf8").replace(
    '    seats: { type: "number", optional: true },\n',
    '    seats: { type: "number", optional: true },\n    notes: { type: "text", optional: true, hidden: true },\n',
  ),
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A repository with no remote and no drafts: a column change is written and committed in the checkout. */
const source: Source = {
  root,
  commit: () => ({ revision: "abcdef0123456789" }),
  head: () => "abcdef0123456789",
};
const config: SanomaConfig = { workflows: [], connectors: [], collections: [outbound], root };
const databaseUrl = testDatabaseUrl("app_columns_local");
const testApp = useTestApp(config, { databaseUrl, source, app: appSteps });
const pool = lazyDb(databaseUrl, "columns local test");
let app: App;

beforeAll(async () => {
  ensureSanomaBuilt();
  app = await startApp(testApp.config, { port: 0, source });
  for (const record of [
    { company: "Acme Plumbing", contact: "dana@acme.test", lastTouched: "2026-11-01", seats: 4, notes: "call back" },
    { company: "Brightwater Dental", contact: "sam@brightwater.test", seats: 2 },
    { company: "Cedar & Finch", contact: "42" },
  ]) {
    await testApp.client.call(
      "data.outbound.save",
      { record: { stage: "researched", owner: "ada", ...record } },
      { actor: { id: "ada" }, id: crypto.randomUUID() },
    );
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool.close();
});

/** The app's context, as the server functions get it. */
const contextOf = async (): Promise<AppContext> => ({
  resolved: resolveConfig(testApp.config),
  snapshot: await appSnapshot(testApp.config, { source }),
  client: testApp.client,
  place: "this-computer",
  login: admitting(loopbackLogin(), () => readPeople(root)),
});
const ada = { id: "ada", groups: ["admin"] };

/** A record as stored, by its key. */
async function stored(key: string) {
  const [row] = await (
    await pool.db()
  )
    .select({ record: data.record })
    .from(data)
    .where(and(eq(data.collection, "outbound"), eq(data.key, key)));
  return row?.record;
}

/** Chrome, at the data page as ada; skipped without it. */
async function chrome(ctx: { skip: (note: string) => void }) {
  const path = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
  if (!existsSync(path)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
  const browser = await launch({ executablePath: path, headless: true });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1440, height: 900 });
  await tab.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "ada"));
  return { browser, tab };
}

describe("a collection's columns with no remote", () => {
  it("leaves a hidden field out of the grid and the record form", async () => {
    const { html } = await pageOf(app, "/data/outbound");
    const menus = [...html.matchAll(/aria-label="Change the column (\w+)"/g)].map(([, field]) => field);
    expect(menus).toEqual(["contact", "stage", "owner", "lastTouched", "seats"]);
    expect(html).not.toContain(">notes<");
    expect(html).not.toContain(">call back<");
    const form = (await pageOf(app, `/data/outbound?record=${encodeURIComponent("Acme Plumbing")}`)).html;
    expect(form).toMatch(/id="field-contact"/);
    expect(form).not.toMatch(/id="field-notes"/);
    expect((await pageOf(app, "/data/outbound?new=true")).html).not.toMatch(/id="field-notes"/);
  });

  it("keeps a hidden field's value when the record form saves an edit", async (ctx) => {
    const { browser, tab } = await chrome(ctx);
    try {
      await tab.goto(new URL(`/data/outbound?record=${encodeURIComponent("Acme Plumbing")}`, app.url).href, {
        waitUntil: "networkidle0",
      });
      await (await tab.waitForSelector("#field-contact"))!.click({ count: 3 });
      await tab.type("#field-contact", "dana@acme.example");
      await (await tab.waitForSelector('button[type="submit"]::-p-text(Save)'))!.click();
      await tab.waitForSelector("[data-sonner-toast]::-p-text(Saved)");
      expect(await stored("Acme Plumbing")).toMatchObject({ contact: "dana@acme.example", notes: "call back" });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("renames a column in the checkout and moves each record's value to the new name", async () => {
    const landed = await proposeColumnChange(await contextOf(), ada, {
      collection: "outbound",
      change: { kind: "rename", from: "lastTouched", to: "lastContact" },
    });
    // Written, the records brought along; nothing here starts the worker again on it.
    expect(landed).toEqual({
      file: "resources/data.ts",
      revision: "abcdef0123456789",
      reshaped: { rows: 3, changed: 1, converted: 0, cleared: 0, kept: 0 },
      running: false,
    });
    expect(readFileSync(join(root, "resources/data.ts"), "utf8")).toContain(
      'lastContact: { type: "date", optional: true },',
    );
    const acme = await stored("Acme Plumbing");
    expect(acme).toMatchObject({ lastContact: "2026-11-01", notes: "call back" });
    expect(acme).not.toHaveProperty("lastTouched");
  });

  it("changes a column's type, leaving empty the values that won't convert, as chosen", async () => {
    const landed = await proposeColumnChange(await contextOf(), ada, {
      collection: "outbound",
      change: { kind: "retype", field: "contact", to: "number", decision: "clear" },
    });
    expect(landed).toMatchObject({
      file: "resources/data.ts",
      reshaped: { rows: 3, changed: 3, converted: 1, cleared: 2, kept: 0 },
    });
    expect(readFileSync(join(root, "resources/data.ts"), "utf8")).toContain('contact: "number",');
    expect(await stored("Cedar & Finch")).toMatchObject({ contact: 42 });
    expect(await stored("Brightwater Dental")).not.toHaveProperty("contact");
  });

  it("says in the panel's toast what became of the records, and that it shows once Sanoma starts again", async (ctx) => {
    const { browser, tab } = await chrome(ctx);
    try {
      await tab.goto(new URL("/data/outbound", app.url).href, { waitUntil: "networkidle0" });
      await (await tab.waitForSelector('button[aria-label="Change the column seats"]'))!.click();
      await (await tab.waitForSelector('[role="menuitem"]::-p-text(Rename)'))!.click();
      await tab.waitForFunction(`document.querySelector("#column-name")?.value === "seats"`);
      await (await tab.$("#column-name"))!.click({ count: 3 });
      await tab.type("#column-name", "headcount");
      await (await tab.waitForSelector('[aria-label="Rename seats"] button[type="submit"]:not([disabled])'))!.click();
      const said = await tab.waitForSelector("[data-sonner-toast]::-p-text(Saved in resources/data.ts.)");
      expect(await said!.evaluate((el) => el.closest("[data-sonner-toast]")?.textContent)).toBe(
        "Saved in resources/data.ts.2 records now hold headcount. It shows here once Sanoma starts again.",
      );
      expect(await stored("Brightwater Dental")).toMatchObject({ headcount: 2 });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
