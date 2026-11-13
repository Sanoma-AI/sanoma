import type { CollectionEntry } from "sanoma/workflows/describe";
import { TableChangePlanSchema, type TableChangePlan } from "sanoma/workflows/description";
import { checkCollection, type Saved } from "sanoma/workflows/shared";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ColumnChange,
  declarationEdit,
  diffLines,
  happens,
  hiddenFields,
  keysIn,
  landed,
  planOf,
  problemOf,
  shownFields,
} from "../src/components/grid/plan.ts";
import { TABLE_CHANGE_PLAN } from "./fixtures/table-change-plan.ts";

// A column change's draft plan (`components/grid/plan.ts`), without a database: `planOf` over
// rows for each kind of change, what it may not change (`problemOf`), what it writes into the
// declaration (`declarationEdit`) and its lines in the review's diff, in words (`happens`), and
// what became of the records once it landed (`landed`); a free-form field's keys; the fields shown
// (`shownFields`, `hiddenFields`), showing a hidden one again and removing it for good; and the review of a table change (`components/grid/review.tsx`) over the plan
// fixture, rendered on the server in a memory router, with all four of its cards.

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

/** Outbound with seats and lastTouched hidden for everyone. */
const hiding = {
  ...outbound,
  fields: {
    ...outbound.fields,
    lastTouched: { type: "date", optional: true, hidden: true },
    seats: { type: "number", optional: true, hidden: true },
  },
} as CollectionEntry;

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
    expect(happens(plan)).toBe("contact becomes a number. 2 records can't convert. Choose below what happens to them.");
    // The person's choice for them goes in the plan, and in what will happen.
    const cleared = planOf(outbound, rows, { kind: "retype", field: "contact", to: "number", decision: "clear" });
    expect(cleared.changes[0]).toMatchObject({ wontConvert: { count: 2 }, decision: "clear" });
    expect(happens(cleared)).toBe(
      "contact becomes a number. 2 records can't convert: they're left empty, and lose what they hold now.",
    );
    expect(happens(planOf(outbound, rows, { kind: "retype", field: "contact", to: "number", decision: "keep" }))).toBe(
      "contact becomes a number. 2 records can't convert: they keep what they hold and show as needs fixing.",
    );
    // None to decide for when every value converts.
    expect(
      planOf(outbound, rows, { kind: "retype", field: "seats", to: "text", decision: "clear" }).changes[0],
    ).not.toHaveProperty("decision");
    // To text, everything converts.
    expect(happens(planOf(outbound, rows, { kind: "retype", field: "seats", to: "text" }))).toBe(
      "seats becomes text. Every value converts.",
    );
  });

  it("removes a column, counting the values it keeps", () => {
    const plan = planOf(outbound, rows, { kind: "hide", field: "seats" });
    expect(plan.changes).toEqual([{ kind: "hide", field: "seats", filled: 2 }]);
    expect(happens(plan)).toBe(
      "seats leaves the grid and the forms for everyone. Its values in 2 records are kept. Fields lists it under Hidden columns, to show again.",
    );
    // Hidden once it lands: the grid and the forms leave it out, Hidden columns lists it.
    const fields = {
      ...outbound.fields,
      seats: edit({ kind: "hide", field: "seats" }).fields["fields.seats"],
    } as CollectionEntry["fields"];
    expect(shownFields(fields)).toEqual(["company", "contact", "stage", "owner", "lastTouched"]);
    expect(hiddenFields(fields)).toEqual(["seats"]);
    expect(hiddenFields(outbound.fields)).toEqual([]);
  });

  it("shows a hidden column again, its values untouched, and removes one for good, counting the values it deletes", () => {
    const shown = planOf(hiding, rows, { kind: "show", field: "seats" });
    expect(shown.changes).toEqual([{ kind: "show", field: "seats", filled: 2 }]);
    expect(happens(shown)).toBe(
      "seats comes back to the grid and the forms for everyone, with its values in 2 records as they were.",
    );
    const removed = planOf(hiding, rows, { kind: "remove", field: "seats" });
    expect(removed.changes).toEqual([{ kind: "remove", field: "seats", filled: 2 }]);
    expect(happens(removed)).toBe(
      "seats is removed for good. Its values in 2 records are deleted, and can't be brought back. Its name is free for a new column.",
    );
    expect(happens(planOf(hiding, rows, { kind: "remove", field: "lastTouched" }))).toBe(
      "lastTouched is removed for good. No record has a value in it, so nothing is lost, and its name is free for a new column.",
    );
  });

  it("renames a column as its own change, never a removal and an addition", () => {
    const plan = planOf(outbound, rows, { kind: "rename", from: "lastTouched", to: "lastContact" });
    expect(plan.changes).toEqual([{ kind: "rename", from: "lastTouched", to: "lastContact" }]);
    expect(happens(plan)).toBe(
      "lastTouched is called lastContact from now on. All 4 records keep their values under the new name.",
    );
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
      "Links and free-form columns aren't available yet",
    );
    expect(refused({ kind: "add", field: "priority", type: "number", required: true })).toBeUndefined();
  });

  it("refuses a hidden column's name until it is removed for good, any change of it but showing or removing it, and either of those on a column not hidden", () => {
    const taken = "seats is taken by a hidden column: remove it for good, under Fields, to use the name";
    expect(problemOf(hiding, { kind: "rename", from: "contact", to: "seats" })).toBe(taken);
    expect(problemOf(hiding, { kind: "add", field: "seats", type: "text", required: false })).toBe(taken);
    for (const kind of ["show", "remove"] as const) {
      expect(problemOf(hiding, { kind, field: "seats" })).toBeUndefined();
      expect(refused({ kind, field: "seats" })).toBe("seats is not hidden");
    }
    for (const change of [
      { kind: "rename", from: "seats", to: "places" },
      { kind: "retype", field: "seats", to: "text" },
      { kind: "require", field: "seats" },
      { kind: "hide", field: "seats" },
    ] as const) {
      expect(problemOf(hiding, change)).toBe("seats is hidden for everyone: show it again first");
    }
    // Once removed for good, the name is free.
    const { seats: _, ...rest } = hiding.fields;
    expect(problemOf({ ...hiding, fields: rest }, { kind: "rename", from: "contact", to: "seats" })).toBeUndefined();
  });

  it("shows a hidden field again as optional, and removes one for good from the declaration: neither leaves a hidden required field", () => {
    const show = declarationEdit(hiding.fields, { kind: "show", field: "seats" });
    expect(show).toEqual({ fields: { "fields.seats": { type: "number", optional: true } }, rename: {} });
    const remove = declarationEdit(hiding.fields, { kind: "remove", field: "seats" });
    expect(remove).toEqual({ fields: {}, rename: { "fields.seats": null } });
    const { seats: _, ...rest } = hiding.fields;
    for (const fields of [{ ...hiding.fields, seats: show.fields["fields.seats"] }, rest]) {
      expect(() => checkCollection({ name: "outbound", key: "company", fields })).not.toThrow();
    }
    // A hidden field is optional: a required one is refused, as the runtime refuses it.
    expect(() =>
      checkCollection({
        name: "outbound",
        key: "company",
        fields: { company: "text", seats: { type: "number", hidden: true } },
      }),
    ).toThrow("may only be marked `hidden: true`, and only when it is `optional: true`");
    expect(diffLines(hiding.fields, [{ kind: "show", field: "seats", filled: 2 }])).toEqual([
      { sign: "-", text: 'seats: { type: "number", optional: true, hidden: true },' },
      { sign: "+", text: 'seats: { type: "number", optional: true },' },
    ]);
    expect(diffLines(hiding.fields, [{ kind: "remove", field: "seats", filled: 2 }])).toEqual([
      { sign: "-", text: 'seats: { type: "number", optional: true, hidden: true },' },
    ]);
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

/** A plan of `change` alone, over outbound's 312 records. */
const one = (change: TableChangePlan["changes"][number]): TableChangePlan => ({
  collection: "outbound",
  rows: 312,
  changes: [change],
});

describe("landed", () => {
  const counts = { rows: 312, changed: 0, converted: 0, cleared: 0, kept: 0 };
  const retype = TABLE_CHANGE_PLAN.changes[2]!;

  it("says what became of the records in plain words, by the change that brought them along", () => {
    const rename = one({ kind: "rename", from: "lastTouched", to: "nextAction" });
    expect(landed(rename, { ...counts, changed: 312 })).toBe("312 records now hold nextAction.");
    expect(landed(rename, { ...counts, changed: 1 })).toBe("1 record now holds nextAction.");
    expect(landed(rename, counts)).toBe("No record had a value in lastTouched.");
    expect(landed(one(retype), { ...counts, changed: 312, converted: 297, cleared: 15 })).toBe(
      "297 contact values converted, 15 left empty.",
    );
    expect(landed(one(retype), { ...counts, changed: 297, converted: 297, kept: 15 })).toBe(
      "297 contact values converted, 15 kept as they were, to fix in the grid.",
    );
    expect(landed(one(retype), counts)).toBe("No contact value needed converting.");
    const remove = one({ kind: "remove", field: "legacyId", filled: 288 });
    expect(landed(remove, { ...counts, changed: 288, cleared: 288 })).toBe("288 legacyId values deleted.");
    expect(landed(remove, counts)).toBe("No record had a value in legacyId.");
    // Several together: each rename by name, the values counted together.
    expect(landed(TABLE_CHANGE_PLAN, { ...counts, changed: 312, converted: 297, cleared: 15 })).toBe(
      "The values of lastTouched are under lastContact now. 297 values converted, 15 left empty.",
    );
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

  /** The review of `plan` (the plan fixture's) as the server renders it, in a router, as the app's pages are. */
  const render = async (status: string, state: { merged?: object } = {}, plan = TABLE_CHANGE_PLAN) => {
    const { TableChangeReview } = await load("../src/components/grid/review.tsx");
    const change = { runId: "change:ui-1234abcd", status, state };
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => createElement(TableChangeReview, { change, plan, collection: outbound }),
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    return renderToString(createElement(RouterProvider, { router }))
      .replaceAll("<!-- -->", "")
      .replaceAll("&#x27;", "'");
  };
  it("draws a card per change in its kind's words, the rows that won't convert with the choice made for them, and Couldn't apply over a failed run", async () => {
    const html = await render("failed");
    expect(cards(html)).toEqual([
      ["Couldn't apply this change", "Nothing changed"],
      ["Add priority", "Safe"],
      ["Rename lastTouched to lastContact", "Safe"],
      ["Change contact from text to a number", "Clears 15 values"],
      ["Remove seats", "Keeps the data"],
    ]);
    expect(html).toContain("All 312 records keep their values under the new name.");
    expect(html).toContain("4 changes to outbound · 312 records. They apply together");
    // The plan a change carries reads back as one, as the change's page reads it.
    expect(TableChangePlanSchema.parse(TABLE_CHANGE_PLAN)).toEqual(TABLE_CHANGE_PLAN);
    expect(html).toContain("297 records convert. 15 can't, because what's in them isn't a number.");
    expect(html).toContain('<td class="px-3 py-1.5">about 40k</td>');
    expect(html).toContain("and 12 records more");
    // The choice made where it was proposed, read-only: no control to change it here.
    expect(html).toContain("Chosen: leave these 15 empty.</span> This removes what they hold now.");
    expect(html).toContain("To choose the other way, send the change back.");
    expect(html).not.toMatch(/type="radio"|role="radio"/);
    expect(html).toContain("The values in 288 records are kept.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Try on a copy<\/button>/);
    expect(html).toContain('href="/runs/change%3Aui-1234abcd"');
    // A run under way has nothing to say it could not apply.
    expect(cards(await render("waiting")).map(([title]) => title)).not.toContain("Couldn't apply this change");
    // Nor one that merged and failed after: what merged is applied.
    const merged = await render("failed", { merged: { sha: "abc", at: 0 } });
    expect(cards(merged).map(([title]) => title)).not.toContain("Couldn't apply this change");
  });

  it("says Keeps for fixing for values chosen to stay, and none decided keeps them", async () => {
    const [add, rename, retype, hide] = TABLE_CHANGE_PLAN.changes;
    const kept = { ...TABLE_CHANGE_PLAN, changes: [add!, rename!, { ...retype!, decision: "keep" as const }, hide!] };
    for (const plan of [
      kept,
      { ...TABLE_CHANGE_PLAN, changes: [add!, rename!, { ...retype!, decision: undefined }, hide!] },
    ]) {
      const html = await render("waiting", {}, plan);
      expect(cards(html)[2]).toEqual(["Change contact from text to a number", "Keeps 15 for fixing"]);
      expect(html).toContain(
        "Chosen: keep them as they are.</span> They show as needs fixing in the grid until someone edits them.",
      );
    }
  });

  it("says plainly how many values removing a column for good deletes, and that showing one again is safe", async () => {
    const remove = { kind: "remove", field: "legacyId", filled: 288 } as const;
    const html = await render(
      "waiting",
      {},
      {
        collection: "outbound",
        rows: 312,
        changes: [{ kind: "show", field: "seats", filled: 2 }, remove],
      },
    );
    expect(cards(html)).toEqual([
      ["Show seats again", "Safe"],
      ["Remove legacyId for good", "Deletes 288 values"],
    ]);
    expect(html).toContain("The values in 2 records are there as they were.");
    expect(html).toContain("Its values in 288 records are deleted, and can't be brought back.");
    expect(cards(await render("waiting", {}, one({ ...remove, filled: 0 })))).toEqual([
      ["Remove legacyId for good", "Safe"],
    ]);
    const reshaped = { rows: 312, changed: 288, converted: 0, cleared: 288, kept: 0 };
    expect(await render("finished", { merged: { sha: "abc", at: 0, reshaped } }, one(remove))).toContain(
      "288 legacyId values deleted.",
    );
  });

  it("says what became of the records once merged, or that they weren't brought along, never that nothing changed", async () => {
    const reshaped = { rows: 312, changed: 312, converted: 297, cleared: 15, kept: 0 };
    const html = await render("finished", { merged: { sha: "abc", at: 0, reshaped } });
    expect(cards(html)[0]).toEqual(["The records", "Updated"]);
    expect(html).toContain("The values of lastTouched are under lastContact now. 297 values converted, 15 left empty.");
    const failed = await render("finished", {
      merged: { sha: "abc", at: 0, reshaped: { error: "the database said no" } },
    });
    expect(cards(failed)[0]).toEqual(["The records weren't updated", "Published without them"]);
    expect(failed).toContain(
      "The change is published, but its records weren't brought along: the database said no. They hold what they held before.",
    );
    expect(failed).toContain('href="/runs/change%3Aui-1234abcd"');
    expect(failed).not.toContain("Nothing changed");
  });
});
