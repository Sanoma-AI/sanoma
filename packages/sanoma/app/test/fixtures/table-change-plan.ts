import type { TableChangePlan } from "sanoma/workflows/description";

// A table change over the outbound fixture's collection with a change of each card's kind, as the
// review board ("Review a table change") draws it: a choice added (Safe), a field renamed (Safe),
// contact retyped to a number with rows that won't convert, left empty as the person chose
// (Clears 15 values), and seats removed, so hidden (Keeps the data).
export const TABLE_CHANGE_PLAN: TableChangePlan = {
  collection: "outbound",
  rows: 312,
  changes: [
    { kind: "add", field: "priority", type: { enum: ["High", "Normal", "Low"] }, required: false, empty: 312 },
    { kind: "rename", from: "lastTouched", to: "lastContact" },
    {
      kind: "retype",
      field: "contact",
      from: "text",
      to: "number",
      wontConvert: {
        count: 15,
        sample: [
          { key: "Acme Plumbing", value: "about 40k" },
          { key: "Delta Roofing", value: "TBD" },
          { key: "Harbor Veterinary", value: "12,000 USD" },
        ],
      },
      decision: "clear",
    },
    { kind: "hide", field: "seats", filled: 288 },
  ],
};
