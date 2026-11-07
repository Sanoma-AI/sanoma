import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, waitFor } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { resolveConfig, type SanomaConfig } from "sanoma/workflows";
import { IMPORT_WORKFLOW, type ImportInput, type Saved } from "sanoma/workflows/shared";
import { type ComponentType, createElement } from "react";
import { executablePath, launch } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outbound } from "../../workflows/test/fixtures/outbound/resources/data.ts";
import { rootWith } from "../../workflows/test/harness.ts";
import { ACTOR_COOKIE } from "../src/api.ts";
import { guessMapping, keyRange, planImport, readSheet, valuesToMap } from "../src/components/import/sheet.ts";
import { type App, startApp } from "../src/index.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { pageApi } from "./page-api.ts";

// Needs Postgres (`pnpm db:up`) and the built app (built when missing or older than src/). A
// sheet imported into a collection: the CSV file read (`readSheet`), its columns matched and its
// rows planned as the run will save them (`components/import/sheet.ts`), the pages (Upload as the
// server renders it, Match columns and Review as they render), and the built-in `import` started
// from the fixture's rows as the page starts it, with its run's page.
// It reads the pages' parts from their components, not `queries.ts`: a test importing a module
// that defines server functions makes TypeScript read Start's `Register` in another order. The
// steps' components load by a path TypeScript does not follow, as `ui.test.ts`'s kit does: they are
// JSX and DOM, checked by typecheck:ui.

/** A step's component, loaded where the root tsconfig (no DOM) does not follow. */
const component = async (path: string, name: string) =>
  ((await import(new URL(path, import.meta.url).href)) as Record<string, ComponentType<Record<string, unknown>>>)[
    name
  ]!;
const MatchColumns = await component("../src/components/import/match.tsx", "MatchColumns");
const Review = await component("../src/components/import/review.tsx", "Review");

const appDir = fileURLToPath(new URL("..", import.meta.url));
const csv = readFileSync(new URL("./fixtures/import/leads.csv", import.meta.url), "utf8");

// The outbound fixture with named people and the policy data.test.ts has: it denies a lead
// `lost` and holds one `won` for `lead`.
const root = rootWith(
  {
    "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace", email: "ada@example.test" });
export const bo = sanoma.person({ id: "bo", name: "Bo" });
export const cy = sanoma.person({ id: "cy" });
export const lead = sanoma.person({ id: "lead" });
`,
    "policies/leads.cedar": `@reason("leads are not lost")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "lost" };

@hold("lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "won" };
`,
  },
  fileURLToPath(new URL("../../workflows/test/fixtures/outbound/", import.meta.url)),
);

const people = [
  { id: "ada", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "bo", name: "Bo" },
  { id: "cy" },
  { id: "lead" },
];
const collection = { name: "outbound", key: outbound.key, fields: outbound.fields };
const sheet = readSheet("leads.csv", csv)!;

/** The fixture's columns as Match columns starts them, with "In talks" mapped to `meeting` as a person would. */
const mapping = guessMapping(collection, sheet, people).map((column) =>
  column?.field === "stage" ? { ...column, values: { "In talks": "meeting" } } : column,
);
const input: ImportInput = { collection: "outbound", mapping, rows: sheet.rows, people: people.map((p) => p.id) };

/** The records the fixture's rows meet: Globex, Inc. to update, Initech as the sheet has it. */
const there = [
  { company: "Globex, Inc.", contact: "bo@globex.test", stage: "contacted", owner: "bo" },
  { company: "Initech", contact: "cy@initech.test", stage: "contacted", owner: "cy" },
];

describe("a CSV file as a sheet", () => {
  it("reads RFC 4180: quoted cells with commas and doubled quotes, CRLF, a byte-order mark, its header, no blank rows at the end", () => {
    expect(sheet.columns).toEqual(["Company", "Contact", "Stage", "Owner", "Last touched", "Seats", "Phone"]);
    expect(sheet.rows.map((row) => row[0])).toEqual(["Acme", "Globex, Inc.", "Initech", "Lost Co", "Hooli", "Won Co"]);
    expect(sheet.rows[1]).toEqual(["Globex, Inc.", "bo@globex.test", "replied", "Bo", "", "", '555 "main"']);
    // A blank row between keeps its place, so the rows below keep their numbers.
    expect(readSheet("lf.csv", 'a,"b\nc"\n1,2\n,\n3,4\n\n')).toEqual({
      file: "lf.csv",
      columns: ["a", "b\nc"],
      rows: [
        ["1", "2"],
        ["", ""],
        ["3", "4"],
      ],
    });
    expect(readSheet("empty.csv", "")).toBeUndefined();
  });

  it("matches columns to fields by name, each once, and guesses what a person's name or email stands for", () => {
    expect(guessMapping(collection, sheet, people)).toEqual([
      { field: "company" },
      { field: "contact" },
      { field: "stage" },
      { field: "owner", values: { "Ada Lovelace": "ada", Bo: "bo" } },
      { field: "lastTouched" },
      { field: "seats" },
      null,
    ]);
    expect(valuesToMap(collection, sheet, 2, "stage", people)).toEqual([{ text: "In talks", rows: 1 }]);
    expect(valuesToMap(collection, sheet, 3, "owner", people)).toEqual([
      { text: "Ada Lovelace", rows: 1, guess: "ada" },
      { text: "Bo", rows: 1, guess: "bo" },
      { text: "T. Nguyen", rows: 1 },
    ]);
    // While nobody is declared, a person field takes any id: nothing to map.
    expect(valuesToMap(collection, sheet, 3, "owner", [])).toEqual([]);
    expect(keyRange(["b", "a", "c"])).toEqual({ gte: "a", lte: "c" });
  });

  it("plans each row as the run will save it, against the records there", () => {
    const found = new Map(there.map((record) => [record.company, saved(record)]));
    expect(planImport(collection, input, found).map((p) => [p.row, p.will])).toEqual([
      [2, "add"],
      [3, "update"],
      [4, "keep"],
      [5, "add"],
      [6, "fix"],
      [7, "add"],
    ]);
  });
});

/** The select named `label` in rendered HTML, its options in it. */
const select = (html: string, label: string) => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `a select named ${label}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</select>", at));
};

/** What the fixture's import does once `lead` approves its held batch. */
const IMPORTED = {
  added: 2,
  updated: 1,
  unchanged: 1,
  problems: [
    { row: 5, key: "Lost Co", reason: "the policy denies saving it: leads are not lost" },
    { row: 6, key: "Hooli", reason: 'owner: "T. Nguyen" is nobody declared; seats: "ten" is not a number' },
  ],
};

/** A record as `list` answers it. */
const saved = (record: Record<string, unknown>): Saved => ({
  key: String(record.company),
  record,
  updatedAt: "2026-11-01T00:00:00Z",
  updatedBy: "ada",
});

describe("the Import pages", () => {
  const config: SanomaConfig = { workflows: [], connectors: [], collections: [outbound], root };
  const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("app_import") });
  let app: App;
  const ada = { id: "ada" };
  const call = (op: string, body: unknown) => testApp.client.call(op, body, { actor: ada, id: crypto.randomUUID() });

  /** The records as the fixture's rows meet them: `there`, and nothing else. */
  const reset = async () => {
    for (const { key } of (await call("data.outbound.list", { limit: 1000 })) as Saved[]) {
      await call("data.outbound.delete", { key });
    }
    for (const record of there) await call("data.outbound.save", { record });
  };
  /** Approves the run's held batch as `lead`, and answers what it did. */
  const approved = async (runId: string) => {
    await waitFor(
      () => testApp.client.approvals(runId),
      (approvals) => approvals.some((a) => a.status === "pending"),
    );
    await testApp.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    return testApp.client.result(runId);
  };

  beforeAll(async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    app = await startApp(testApp.config, { port: 0 });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  /** A page as the server renders it for ada (the loopback login's cookie), comments between text parts gone. */
  const page = async (path: string) => {
    const res = await fetch(new URL(path, app.url), { headers: { cookie: `${ACTOR_COOKIE}=ada` } });
    return { status: res.status, html: (await res.text()).replaceAll("<!-- -->", "") };
  };

  it("links Import from the collection's page, and starts at Upload under Data / Outbound", async () => {
    expect((await page("/data/outbound")).html).toMatch(/<a [^>]*href="\/data\/outbound\/import"[^>]*>.*Import<\/a>/);
    const { status, html } = await page("/data/outbound/import");
    expect(status).toBe(200);
    expect(html).toMatch(
      /<a [^>]*href="\/data"[^>]*>Data<\/a>[\s\S]*<a [^>]*href="\/data\/outbound"[^>]*>Outbound<\/a>/,
    );
    expect(html).toMatch(/<h1[^>]*>Import<\/h1>/);
    expect(html).toMatch(/<li aria-current="step"[^>]*>1 Upload ·<\/li>/);
    expect(html).toContain("Drop a CSV file here, or choose one");
    expect(html).toMatch(/<input type="file" accept=".csv,text\/csv"[^>]*name="sheet"/);
    expect((await page("/data/nope/import")).html).toContain("No collection nope.");
  });

  it("matches each column with a select, a column no field names offered as a field to add first, and lists the values to map and the rows refused", () => {
    const html = renderToStaticMarkup(
      createElement(MatchColumns, {
        collection,
        sheet,
        mapping: guessMapping(collection, sheet, people),
        people,
        onMapping: () => {},
        onBack: () => {},
        onNext: () => {},
      }),
    );
    expect(select(html, "The field Company fills")).toMatch(/value="company" selected="">company · the key</);
    // A field another column fills is not offered twice.
    expect(select(html, "The field Company fills")).toMatch(/value="stage" disabled="">stage</);
    expect(select(html, "The field Phone fills")).toMatch(/value="" selected="">Skip</);
    expect(select(html, "The field Phone fills")).toMatch(
      /disabled="">New field: Phone \(text\): add this field first</,
    );
    expect(select(html, "The field Stage fills")).not.toContain("New field");
    expect(html).toContain('<b class="font-medium">Stage</b> has values stage does not take as written.');
    expect(html).toMatch(/“In talks” <span[^>]*>\(1 row\)<\/span>/);
    expect(select(html, "What “In talks” stands for")).toMatch(/selected="">Fix first</);
    expect(select(html, "What “Ada Lovelace” stands for")).toMatch(/value="ada" selected="">Ada Lovelace \(ada\)</);
    expect(select(html, "What “T. Nguyen” stands for")).toMatch(/selected="">Fix first</);
    expect(html).toContain("2 problems");
    expect(html).toContain(
      "Row 2: stage: &quot;In talks&quot; is not one of researched, contacted, replied, meeting, won, lost",
    );
    expect(html).toContain(
      "Row 6: owner: &quot;T. Nguyen&quot; is nobody declared; seats: &quot;ten&quot; is not a number",
    );
  });

  it("reviews what each row will do, an update with what it was, and offers to add and update them", () => {
    const found = new Map(there.map((record) => [record.company, saved(record)]));
    const html = renderToStaticMarkup(
      createElement(Review, {
        planned: planImport(collection, input, found),
        fields: ["company", "contact", "stage", "owner", "lastTouched", "seats"],
        starting: false,
        onBack: () => {},
        onImport: () => {},
      }),
    );
    expect(html).toContain("6 rows");
    expect(html).toContain("3 new records");
    expect(html).toContain("1 update existing");
    expect(html).toContain("1 unchanged");
    expect(html).toContain("1 with problems");
    expect(html).toMatch(/>update<\/td>[\s\S]*?replied<span[^>]*>was contacted<\/span>/);
    expect(html).toMatch(/>fix first<\/td><td [^>]*colSpan="6"[^>]*><span[^>]*>Hooli<\/span>/i);
    expect(html).toMatch(/<button[^>]*>Add 3, update 1<\/button>/);
  });

  it("imports the rows as a run of the person, denying what the policy denies and holding a batch it holds; its page shows the steps", async () => {
    const context = {
      resolved: resolveConfig(testApp.config),
      snapshot: await appSnapshot(testApp.config),
      client: testApp.client,
      place: "this-computer" as const,
      login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
    };
    await reset();
    const { runId } = (await pageApi(context, ada)[IMPORT_WORKFLOW]!.start(input)) as { runId: string };
    expect(await approved(runId)).toEqual(IMPORTED);
    const records = (await call("data.outbound.list", {})) as Saved[];
    expect(records.map(({ key, record, updatedBy }) => [key, record.stage, updatedBy])).toEqual([
      ["Acme", "meeting", `run:${runId}`],
      ["Globex, Inc.", "replied", `run:${runId}`],
      ["Initech", "contacted", "ada"],
      ["Won Co", "won", `run:${runId}`],
    ]);
    const { status, html } = await page(`/workflows/import/runs/${encodeURIComponent(runId)}`);
    expect(status).toBe(200);
    expect(html).toContain("Import a spreadsheet");
    expect(html).toContain("data.outbound.list");
    expect(html).toContain("data.outbound.save");
  });

  it("uploads, matches and reviews the sheet in Chrome, then starts the run and opens it", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    await reset();
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await tab.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "ada"));
      await tab.goto(new URL("/data/outbound/import", app.url).href, { waitUntil: "networkidle0" });
      const file = await tab.waitForSelector('input[type="file"]');
      await file!.uploadFile(fileURLToPath(new URL("./fixtures/import/leads.csv", import.meta.url)));
      await tab.waitForSelector("::-p-text(leads.csv)");
      await (await tab.waitForSelector("button::-p-text(Match columns)"))!.click();
      await tab.waitForFunction(`location.search.includes("step=match")`);
      await tab.select('select[aria-label="What “In talks” stands for"]', "meeting");
      await tab.waitForSelector("::-p-text(1 problem)");
      await (await tab.waitForSelector("button::-p-text(Review)"))!.click();
      const add = await tab.waitForSelector("button::-p-text(Add 3, update 1)");
      expect(await tab.evaluate(`document.querySelector('[aria-label="Import preview"]').textContent`)).toContain(
        "was contacted",
      );
      await add!.click();
      await tab.waitForFunction(`location.pathname.startsWith("/workflows/import/runs/")`);
      const runId = decodeURIComponent(new URL(tab.url()).pathname.split("/").at(-1)!);
      expect(await approved(runId)).toEqual(IMPORTED);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
