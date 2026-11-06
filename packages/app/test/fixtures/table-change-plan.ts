import type { TableChangePlan } from "../../src/components/grid/plan.ts";

// A table change over the outbound fixture's collection with a change of each card's kind, as the
// review board ("Review a table change") draws it: a choice added (Safe), a field renamed (Safe),
// contact retyped to a number with rows that won't convert and no decision yet (Needs a decision),
// and seats removed (Keeps the data). The runtime's plan, once it lands, has this shape (#630).
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
    },
    { kind: "delete", field: "seats", filled: 288 },
  ],
  sql: [],
  blocked: true,
};
