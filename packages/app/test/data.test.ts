import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { memoryLedger, resolveConfig, SanomaClient, type SanomaConfig } from "@sanoma-ai/workflows";
import { collection } from "@sanoma-ai/workflows/data";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import outboundNext from "../../workflows/test/fixtures/outbound/workflows/outbound-next.ts";
import { ACTOR_COOKIE, ApiError, CallRequest, type ErrorResponse } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { callApi, serverFnFailure, validate } from "../src/server/core.ts";

// Needs Postgres (`pnpm db:up`) and the built app: the tests build it when dist/server/server.js
// is missing or older than a file under src/. The Data section: `/data`, a collection's grid and
// record form, its calls as the person (`callFn`), and Used by. The one test in a browser needs
// Google Chrome, or `CHROME_PATH` naming a Chrome or Chromium binary, and skips without either.
// It reads the grid through its pages, not `queries.ts`: a test importing a module that defines
// server functions makes TypeScript read Start's `Register` in another order, and lose its types.

const appDir = fileURLToPath(new URL("..", import.meta.url));

// The outbound fixture, copied to a root of its own: its collection, declared in resources/data.ts,
// with its people and a policy that allows, but denies a lead `lost` and holds one `won` for `lead`.
const root = mkdtempSync(join(tmpdir(), "sanoma-data-"));
cpSync(fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)), root, { recursive: true });
writeFileSync(
  join(root, "resources/people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const cy = sanoma.person({ id: "cy" });
export const lead = sanoma.person({ id: "lead" });
`,
);
mkdirSync(join(root, "policies"));
writeFileSync(
  join(root, "policies/leads.cedar"),
  `@reason("leads are not lost")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "lost" };

@hold("lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "won" };
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The outbound fixture's workflow, over that root.
const config: SanomaConfig = {
  workflows: [outboundNext],
  connectors: [],
  collections: [outbound],
  root,
};
const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("data") });
let app: App;

beforeAll(async () => {
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(testApp.config, { port: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const lead = (company: string, stage = "researched", owner = "ada") => ({
  company,
  contact: `${owner}@${company.toLowerCase().replaceAll(" ", "-")}.test`,
  stage,
  owner,
});

/** Saves a record as `by`, through the runtime's client, as the app calls it. */
const seed = (record: Record<string, unknown>, by = "ada") =>
  testApp.client.call("data.outbound.save", { record }, { actor: { id: by }, id: crypto.randomUUID() });

/** The record the browser test adds, as the runtime reads it; null once deleted. */
const puppet = async () =>
  (await testApp.client.call("data.outbound.get", { key: "Puppet" }, { actor: { id: "ada" } })) as {
    record: Record<string, unknown>;
    updatedBy: string;
  } | null;

/** A page as the server renders it for `actor` (the loopback login's cookie), comments between text parts gone. */
async function page(path: string, actor: string | null = "ada") {
  const headers: Record<string, string> = actor ? { cookie: `${ACTOR_COOKIE}=${encodeURIComponent(actor)}` } : {};
  const res = await fetch(new URL(path, app.url), { headers });
  return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
}

/** The grid's rows, in order: each record's key, from its link (which keeps the rest of the search). */
const rowKeys = (html: string) =>
  [...html.matchAll(/<a [^>]*href="\/data\/outbound\?([^"]*)"[^>]*>/g)].flatMap(([, search]) => {
    const key = new URLSearchParams(search!.replaceAll("&amp;", "&")).get("record");
    return key === null ? [] : [key];
  });

/** A search the way the router writes it: each value JSON, but a plain string as itself. */
const searchOf = (search: Record<string, unknown>) =>
  "?" +
  new URLSearchParams(
    Object.entries(search).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  ).toString();

/** `callFn` as the page's form calls it, as `actor`: its answer, or the ApiError's status and body. */
async function callAs(actor: string, data: CallRequest) {
  const context = {
    resolved: resolveConfig(testApp.config),
    description: describeConfig(testApp.config),
    client: testApp.client,
    place: "this-computer" as const,
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  };
  try {
    return { body: (await callApi(context, { id: actor }, validate(CallRequest)(data))) as any };
  } catch (err) {
    const failure = serverFnFailure(err, "POST");
    if (!(failure instanceof ApiError)) throw failure;
    return { status: failure.status, body: failure.body as ErrorResponse };
  }
}

describe("the Data section", () => {
  beforeAll(async () => {
    // The database outlives a run: start from no records.
    const left = (await testApp.client.call("data.outbound.list", { limit: 1000 }, { actor: { id: "ada" } })) as {
      key: string;
    }[];
    for (const { key } of left) {
      await testApp.client.call("data.outbound.delete", { key }, { actor: { id: "ada" }, id: crypto.randomUUID() });
    }
    for (const record of [lead("Acme"), lead("Globex", "contacted", "bo"), lead("Initech", "meeting")]) {
      await seed(record);
    }
    await seed({ ...lead("Gizmo", "contacted"), seats: 12 }, "bo");
  });

  it("puts Data in the bar, and /data listing each collection in a table, a row linking to its grid", async () => {
    const { status, html } = await page("/data");
    expect(status).toBe(200);
    // Data in the bar, lit here, with Sites and Data in their own group (no sites in this config).
    expect(html).toMatch(
      /<nav aria-label="Sections"[^>]*>(?:(?!<\/nav>)[\s\S])*<a [^>]*href="\/data"[^>]*aria-current="page"[^>]*>(?:(?!<\/a>)[\s\S])*Data<\/a>/,
    );
    // The page's title, with how many collections there are.
    expect(html).toMatch(/<h1[^>]*>Data<span[^>]*>1<\/span><\/h1>/);
    const row = html.match(
      /<tr[^>]*><td[^>]*><div[^>]*><a [^>]*href="\/data\/outbound"[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/,
    )?.[0];
    expect(row).toContain(">Outbound</a>");
    expect(row).toContain(">data.outbound</code>");
    expect(row).toMatch(/<td[^>]*>6<\/td><td[^>]*><code>company<\/code><\/td>/);
    expect(row).toContain(">resources/data.ts#outbound</code>");
  });

  it("renders a collection's grid with its records as the person, sorted, filtered and limited as the search says", async () => {
    const grid = await page("/data/outbound");
    expect(grid.status).toBe(200);
    expect(rowKeys(grid.html)).toEqual(["Acme", "Gizmo", "Globex", "Initech"]);
    // A column per field, in the collection's order, then who saved each and when.
    const heads = [...grid.html.matchAll(/<th [^>]*>(?:<a [^>]*>)?([^<]+)/g)].map(([, text]) => text);
    expect(heads).toEqual(["company", "contact", "stage", "owner", "lastTouched", "seats", "Updated", "By"]);
    expect(grid.html).toContain(">bo</td>");
    // Its title under the Data crumb.
    expect(grid.html).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*><ol[^>]*><li[^>]*><a [^>]*href="\/data"[^>]*>Data<\/a>/,
    );
    expect(grid.html).toMatch(/<h1[^>]*>Outbound/);
    expect(grid.html).toMatch(/Declared in <a [^>]*href="\/resources\?resource=resources%2Fdata\.ts%23outbound"/);

    expect(rowKeys((await page(`/data/outbound${searchOf({ order: "-company" })}`)).html)).toEqual([
      "Initech",
      "Globex",
      "Gizmo",
      "Acme",
    ]);
    expect(rowKeys((await page(`/data/outbound${searchOf({ order: "seats" })}`)).html)[0]).toBe("Gizmo");
    // An enum field equal to a value, and the keys that start with what is typed.
    const contacted = await page(`/data/outbound${searchOf({ where: { stage: "contacted" } })}`);
    expect(rowKeys(contacted.html)).toEqual(["Gizmo", "Globex"]);
    expect(rowKeys((await page(`/data/outbound${searchOf({ key: "Gi" })}`)).html)).toEqual(["Gizmo"]);
    const limited = await page(`/data/outbound${searchOf({ limit: 2 })}`);
    expect(rowKeys(limited.html)).toEqual(["Acme", "Gizmo"]);
    expect(limited.html).toContain("The first 2 records");
    // The sort's heading says which way.
    expect((await page(`/data/outbound${searchOf({ order: "-company" })}`)).html).toMatch(
      /<th [^>]*aria-sort="descending"[^>]*><a [^>]*>company/,
    );
  });

  it("leaves out of the query what names nothing: a field it lacks, a value its enum lacks", async () => {
    const all = rowKeys((await page("/data/outbound")).html);
    const ignored = await page(`/data/outbound${searchOf({ order: "nope", where: { stage: "archived", nope: "x" } })}`);
    expect(rowKeys(ignored.html)).toEqual(all);
    // A where on a field that is no enum is no filter of the grid's.
    expect(rowKeys((await page(`/data/outbound${searchOf({ where: { owner: "bo" } })}`)).html)).toEqual(all);
  });

  it("refuses the records to nobody, and says so", async () => {
    const { status, html } = await page("/data/outbound", null);
    expect(status).toBe(200);
    expect(rowKeys(html)).toEqual([]);
    expect(html).toContain('aria-label="Loading the records"');
  });

  it("flags a record saved under fields that have changed since, with what they refuse", async () => {
    // The collection as it was: a stage of any text, and no contact or owner.
    const older = collection({ name: "outbound", key: "company", fields: { company: "text", stage: "text" } });
    const client = await SanomaClient.connect({
      workflows: [],
      connectors: [],
      collections: [older],
      ledger: memoryLedger(),
      databaseUrl: testApp.config.databaseUrl,
    });
    try {
      await client.call(
        "data.outbound.save",
        { record: { company: "Old Co", stage: "archived" } },
        { actor: { id: "ada" }, id: crypto.randomUUID() },
      );
    } finally {
      await client.close();
    }
    const { html } = await page(`/data/outbound${searchOf({ key: "Old" })}`);
    expect(rowKeys(html)).toEqual(["Old Co"]);
    expect(html).toContain("needs fixing");
    // Where the fields refuse it, in the flag's tooltip (and its description).
    expect(html).toContain("Saved before its fields changed: contact: ");
    expect(html).toMatch(/Saved before its fields changed: contact: .*; stage: .*; owner: /);
    // Its form opens with what it has.
    expect((await page(`/data/outbound${searchOf({ key: "Old", record: "Old Co" })}`)).html).toContain(
      'value="Old Co"',
    );
  });

  it("draws the record form from the fields: a new record's people as the person, an edit's key read-only", async () => {
    const added = (await page("/data/outbound?new=true")).html;
    expect(added).toContain(">New record</h2>");
    expect(added).toMatch(/<input[^>]*id="field-company"[^>]*type="text"/);
    expect(added).toMatch(/<select[^>]*id="field-stage"/);
    expect(added).toMatch(/<input[^>]*id="field-lastTouched"[^>]*type="date"/);
    expect(added).toMatch(/<input[^>]*id="field-seats"[^>]*type="number"/);
    // A person's input: as text, empty until the browser has read who is asking.
    expect(added).toMatch(/<input[^>]*id="field-owner"[^>]*type="text"/);
    expect(added).not.toContain(">Delete<");
    const edit = (await page(`/data/outbound${searchOf({ record: "Globex" })}`)).html;
    expect(edit).toContain(">Edit Globex</h2>");
    expect(edit).toMatch(
      /<fieldset disabled="" class="contents">(?:(?!<\/fieldset>)[\s\S])*id="field-company"[^>]*value="Globex"/,
    );
    expect(edit).toMatch(/<input[^>]*id="field-owner"[^>]*value="bo"/);
    expect(edit).toContain(">Delete<");
  });

  it("saves as the person, refuses a denial and what the fields refuse, and holds a save for an approval in a run of call", async () => {
    const saved = await callAs("cy", {
      name: "data.outbound.save",
      input: { record: lead("Hooli") },
      id: crypto.randomUUID(),
    });
    expect(saved.body).toMatchObject({ key: "Hooli", updatedBy: "cy" });
    expect(rowKeys((await page(`/data/outbound${searchOf({ key: "Hoo" })}`)).html)).toEqual(["Hooli"]);
    expect(
      await callAs("cy", { name: "data.outbound.save", input: { record: lead("Lost Co", "lost") } }),
    ).toMatchObject({
      status: 403,
      body: { code: "policy_denied", error: expect.stringMatching(/leads are not lost/) },
    });
    // What the form puts on its fields: each issue at `record.<field>`.
    expect(await callAs("cy", { name: "data.outbound.save", input: { record: { company: "No Co" } } })).toMatchObject({
      status: 400,
      body: {
        code: "invalid_input",
        issues: expect.arrayContaining([expect.objectContaining({ path: ["record", "contact"] })]),
      },
    });
    const id = crypto.randomUUID();
    const held = await callAs("cy", { name: "data.outbound.save", input: { record: lead("Won Co", "won") }, id });
    expect(held).toEqual({
      status: 409,
      body: { error: expect.any(String), code: "approval_pending", runId: `call:cy:${id}` },
    });
    // The toast's link: the call's run, under the built-in call workflow.
    expect((await page(`/workflows/call/runs/call:cy:${id}`)).status).toBe(200);
    expect(
      await callAs("cy", { name: "data.outbound.delete", input: { key: "Hooli" }, id: crypto.randomUUID() }),
    ).toEqual({ body: { deleted: true } });
    expect(rowKeys((await page(`/data/outbound${searchOf({ key: "Hoo" })}`)).html)).toEqual([]);
  });

  it("lists the workflows that use the collection, never the built-in call, and keeps data off Connectors", async () => {
    const { html } = await page("/data/outbound");
    expect(html).toContain(">Used by</h2>");
    expect(html).toMatch(/<a [^>]*href="\/workflows\/outbound-next"[^>]*>(?:(?!<\/a>)[\s\S])*Move a lead on/);
    expect(html).not.toContain('href="/workflows/call"');
    // `data` is no outside vendor: not a connector, not called "for real".
    expect((await page("/connectors")).html).not.toContain('href="/connectors/data"');
    expect((await page("/workflows/outbound-next?new=true")).html).not.toContain("for real");
  });

  it("lists the collections on the Resources page, each linking to its grid", async () => {
    const { html } = await page("/resources");
    expect(html).toContain(">Collections</h2>");
    expect(html).toMatch(/<a [^>]*href="\/data\/outbound"[^>]*>Outbound<\/a>/);
  });

  it("adds, edits, holds, refuses and deletes a record from the grid in Chrome, as the person", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await tab.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "ada"));
      await tab.goto(new URL("/data/outbound?new=true", app.url).href, { waitUntil: "networkidle0" });
      // A new record's person starts as whoever is asking.
      await tab.waitForFunction(`document.querySelector("#field-owner")?.value === "ada"`);
      await tab.type("#field-company", "Puppet");
      await tab.type("#field-contact", "pat@puppet.test");
      await tab.select("#field-stage", "0");
      await tab.click('main button[type="submit"]');
      await tab.waitForSelector('a[href="/data/outbound?record=Puppet"]');
      expect(await puppet()).toMatchObject({
        record: { company: "Puppet", contact: "pat@puppet.test", stage: "researched", owner: "ada" },
        updatedBy: "ada",
      });

      // Add again under that key: refused on the field, the record as it was.
      await tab.click('a[href="/data/outbound?new=true"]');
      await tab.waitForSelector("#field-company:not(:disabled)");
      await tab.type("#field-company", "Puppet");
      await tab.type("#field-contact", "other@puppet.test");
      await tab.select("#field-stage", "1");
      await tab.click('main button[type="submit"]');
      await tab.waitForSelector("::-p-text(A record has this key already)");
      expect((await puppet())?.record.contact).toBe("pat@puppet.test");

      // Edit: the key stays, the stage moves on.
      await tab.click('a[href="/data/outbound?record=Puppet"]');
      await tab.waitForSelector("#field-company:disabled");
      await tab.select("#field-stage", "1");
      await tab.click('main button[type="submit"]');
      await waitFor(
        async () => (await puppet())?.record.stage,
        (stage) => stage === "contacted",
      );

      // A denial shows on the form; a held save says so, linking to its run.
      await tab.click('a[href="/data/outbound?record=Puppet"]');
      await tab.waitForSelector("#field-company:disabled");
      await tab.select("#field-stage", "5");
      await tab.click('main button[type="submit"]');
      await tab.waitForSelector('[data-slot="alert"]::-p-text(leads are not lost)');
      await tab.select("#field-stage", "4");
      await tab.click('main button[type="submit"]');
      const link = await tab.waitForSelector('a[href^="/workflows/call/runs/call"]::-p-text(Open the run)');
      expect(await link!.evaluate((a) => a.closest("[data-sonner-toast]")?.textContent)).toContain("Held for approval");
      expect((await puppet())?.record.stage).toBe("contacted");

      // Delete, once confirmed.
      await tab.click('a[href="/data/outbound?record=Puppet"]');
      await (await tab.waitForSelector("button::-p-text(Delete)"))!.click();
      await (await tab.waitForSelector('[role="dialog"] button::-p-text(Delete)'))!.click();
      await waitFor(puppet, (found) => found === null);
      await tab.waitForFunction(`!document.querySelector('a[href="/data/outbound?record=Puppet"]')`);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
