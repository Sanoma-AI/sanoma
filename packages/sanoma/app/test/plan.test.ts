import type { CollectionEntry } from "sanoma/workflows/describe";
import { TableChangePlanSchema, type TableChangePlan } from "sanoma/workflows/description";
import type { Saved } from "sanoma/workflows/shared";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ColumnChange,
  declarationEdit,
  diffLines,
  happens,
  keysIn,
  planOf,
  problemOf,
} from "../src/components/grid/plan.ts";
import { TABLE_CHANGE_PLAN } from "./fixtures/table-change-plan.ts";

// A column change's draft plan (`components/grid/plan.ts`), without a database: `planOf` over
// rows for each kind of change, what it may not change (`problemOf`), what it writes into the
// declaration (`declarationEdit`) and its lines in the review's diff, in words (`happens`); a
// free-form field's keys; and the review of a table change (`components/grid/review.tsx`) over
// the plan fixture, rendered on the server in a memory router, with all four of its cards.

/** The outbound fixture's collection, as the description has it, with a free-form `details` field the runtime does not take yet. */
const outbound = {
  name: "outbound",
  key: "company",
  fields: {
    company: "text",
    contact: "text",
    stage: { enum: ["researched", "contacted", "won"] },
    owner: "person",
    lastTouched: { type: "date", optional: true },
    seats: { type: "number", optional: true },
  },
  record: {},
  ops: [],
} as unknown as CollectionEntry;

const row = (key: string, record: Record<string, unknown>): Saved => ({
  key,
  record: { company: key, ...record },
  updatedAt: "2026-11-06T00:00:00.000Z",
  updatedBy: "ada",
});
const rows = [
  row("Acme Plumbing", { contact: "40", seats: 4, details: { source: "csv", seats: 4 } }),
  row("Brightwater Dental", { contact: "about 40k", seats: 2, details: { source: "web" } }),
  row("Cedar & Finch", { contact: "TBD", details: { source: "csv", seats: "two" } }),
  row("Delta Roofing", { contact: "" }),
];

/** Why `change` cannot be proposed on outbound, if it cannot. */
const refused = (change: ColumnChange) => problemOf(outbound, change);
/** What `change` writes into outbound's declaration. */
const edit = (change: ColumnChange) => declarationEdit(outbound.fields, change);
/** Each card's title and what it says it is, in order. */
const cards = (html: string) =>
  [...html.matchAll(/<h2>([^<]*)<\/h2>(?:(?!<h2>)[\s\S])*?data-slot="badge"[^>]*>([^<]*)</g)].map(([, title, said]) => [
    title,
    said,
  ]);

describe("planOf", () => {
  it("adds a column every record shows empty, and says so", () => {
    const change: ColumnChange = { kind: "add", field: "priority", type: { enum: ["High", "Low"] }, required: false };
    const plan = planOf(outbound, rows, change);
    expect(plan).toEqual({
      collection: "outbound",
      changes: [{ ...change, empty: 4 }],
      rows: 4,
    });
    expect(happens(plan)).toBe(
      "outbound gains a priority column. All 4 records show it empty, and nothing else changes.",
    );
    // A required one leaves each record needing a value.
    expect(happens(planOf(outbound, rows, { ...change, required: true }))).toBe(
      "outbound gains a required priority column. All 4 records show it empty, and each needs a value before it saves again.",
    );
  });

  it("retypes a column, counting and sampling the filled values that won't convert", () => {
    const plan = planOf(outbound, rows, { kind: "retype", field: "contact", to: "number" });
    expect(plan.changes).toEqual([
      {
        kind: "retype",
        field: "contact",
        from: "text",
        to: "number",
        // The empty one is no value to convert.
        wontConvert: {
          count: 2,
          sample: [
            { key: "Brightwater Dental", value: "about 40k" },
            { key: "Cedar & Finch", value: "TBD" },
          ],
        },
      },
    ]);
    expect(happens(plan)).toBe(
      "contact becomes a number. 2 records can't convert, and the review asks what to do with them.",
    );
    // To text, everything converts.
    expect(happens(planOf(outbound, rows, { kind: "retype", field: "seats", to: "text" }))).toBe(
      "seats becomes text. Every value converts.",
    );
  });

  it("removes a column, counting the values it keeps", () => {
    const plan = planOf(outbound, rows, { kind: "hide", field: "seats" });
    expect(plan.changes).toEqual([{ kind: "hide", field: "seats", filled: 2 }]);
    expect(happens(plan)).toBe("seats leaves the grid and the forms. Its values in 2 records are kept.");
  });

  it("renames a column as its own change, never a removal and an addition", () => {
    const plan = planOf(outbound, rows, { kind: "rename", from: "lastTouched", to: "lastContact" });
    expect(plan.changes).toEqual([{ kind: "rename", from: "lastTouched", to: "lastContact" }]);
    expect(happens(plan)).toBe("lastTouched is called lastContact from now on. All 4 records keep their values.");
    expect(declarationEdit(outbound.fields, { kind: "rename", from: "lastTouched", to: "lastContact" })).toEqual({
      fields: {},
      rename: { "fields.lastTouched": "lastContact" },
    });
  });
});

describe("a column change", () => {
  it("refuses a field the collection lacks, a name taken, the key, and a type the runtime does not take yet", () => {
    expect(refused({ kind: "hide", field: "nope" })).toBe("nope is not a field of this collection");
    expect(refused({ kind: "add", field: "stage", type: "text", required: false })).toBe("stage is a field already");
    expect(refused({ kind: "rename", from: "stage", to: "owner" })).toBe("owner is a field already");
    expect(refused({ kind: "retype", field: "company", to: "number" })).toBe(
      "company is the key, which names each record: it stays as it is",
    );
    expect(refused({ kind: "add", field: "notes", type: "json", required: false })).toBe(
      "Links and free-form columns arrive with real tables",
    );
    expect(refused({ kind: "add", field: "priority", type: "number", required: true })).toBeUndefined();
  });

  it("sets the declaration's field for an add, a retype and a requirement, keeping whether it was optional; hides it, optional, for a removal", () => {
    expect(edit({ kind: "add", field: "priority", type: { enum: ["High"] }, required: false }).fields).toEqual({
      "fields.priority": { enum: ["High"], optional: true },
    });
    expect(edit({ kind: "retype", field: "seats", to: "text" }).fields).toEqual({
      "fields.seats": { type: "text", optional: true },
    });
    expect(edit({ kind: "retype", field: "contact", to: "number" }).fields).toEqual({ "fields.contact": "number" });
    expect(edit({ kind: "require", field: "lastTouched" }).fields).toEqual({ "fields.lastTouched": "date" });
    expect(edit({ kind: "hide", field: "contact" })).toEqual({
      fields: { "fields.contact": { type: "text", optional: true, hidden: true } },
      rename: {},
    });
  });

  it("lists the declaration's lines a plan removes and adds, as the review's diff shows them", () => {
    expect(diffLines(outbound.fields, TABLE_CHANGE_PLAN.changes)).toEqual([
      { sign: "+", text: 'priority: { enum: ["High", "Normal", "Low"], optional: true },' },
      { sign: "-", text: 'lastTouched: { type: "date", optional: true },' },
      { sign: "+", text: 'lastContact: { type: "date", optional: true },' },
      { sign: "-", text: 'contact: "text",' },
      { sign: "+", text: 'contact: "number",' },
      { sign: "-", text: 'seats: { type: "number", optional: true },' },
      { sign: "+", text: 'seats: { type: "number", optional: true, hidden: true },' },
    ]);
  });

  it("finds a free-form field's keys with how many records hold each, the most first", () => {
    expect(keysIn(rows, "details")).toEqual([
      { key: "source", count: 3 },
      { key: "seats", count: 2 },
    ]);
  });
});

describe("TableChangeReview", () => {
  // By a path TypeScript does not follow: the components are JSX and DOM, checked by typecheck:ui.
  type Review = (props: {
    change: { runId: string; status: string; state: { merged?: object } };
    plan: TableChangePlan;
    collection: CollectionEntry | undefined;
  }) => ReactNode;
  const load = (path: string) => import(new URL(path, import.meta.url).href) as Promise<{ TableChangeReview: Review }>;

  /** The review of the plan fixture as the server renders it, in a router, as the app's pages are. */
  const render = async (status: string, state: { merged?: object } = {}) => {
    const { TableChangeReview } = await load("../src/components/grid/review.tsx");
    const change = { runId: "change:ui-1234abcd", status, state };
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => createElement(TableChangeReview, { change, plan: TABLE_CHANGE_PLAN, collection: outbound }),
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return renderToString(createElement(RouterProvider, { router }))
      .replaceAll("<!-- -->", "")
      .replaceAll("&#x27;", "'");
  };
  it("draws a card per change in its kind's words, the rows that won't convert with their two choices, and Couldn't apply over a failed run", async () => {
    const html = await render("failed");
    expect(cards(html)).toEqual([
      ["Couldn't apply this change", "Nothing changed"],
      ["Add priority", "Safe"],
      ["Rename lastTouched to lastContact", "Safe"],
      ["Change contact from text to a number", "Needs a decision"],
      ["Remove seats", "Keeps the data"],
    ]);
    expect(html).toContain("4 changes to outbound · 312 records. They apply together");
    // The plan a change carries reads back as one, as the change's page reads it.
    expect(TableChangePlanSchema.parse(TABLE_CHANGE_PLAN)).toEqual(TABLE_CHANGE_PLAN);
    expect(html).toContain("297 records convert. 15 can't, because what's in them isn't a number.");
    expect(html).toContain('<td class="px-3 py-1.5">about 40k</td>');
    expect(html).toContain("and 12 records more");
    expect(html).toContain("Convert the rest and leave these 15 empty");
    expect(html).toContain("Keep contact as text while someone fixes them in the grid");
    expect(html).toContain("The values in 288 records are kept.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Try on a copy<\/button>/);
    expect(html).toContain('href="/runs/change%3Aui-1234abcd"');
    // A run under way has nothing to say it could not apply.
    expect(cards(await render("waiting")).map(([title]) => title)).not.toContain("Couldn't apply this change");
    // Nor one that merged and failed after: what merged is applied.
    const merged = await render("failed", { merged: { sha: "abc", at: 0 } });
    expect(cards(merged).map(([title]) => title)).not.toContain("Couldn't apply this change");
  });
});
