// The company's own records, kept in its database. A collection's operations (`data.<name>.get`,
// `.list`, `.save` and `.delete`) are what a workflow names in `uses` and calls on
// `ctx.data.<name>`, under the policy and in the ledger. Workflows import this file
// (`import { outbound } from "../resources/data.ts"`), so it imports only from "sanoma/data" and
// holds only collections.
import { collection } from "sanoma/data";

/** The outbound pipeline: which lead is at which stage, and who owns it. */
export const outbound = collection({
  name: "outbound",
  title: "Outbound",
  // Each record is found by its company: a required text field.
  key: "company",
  fields: {
    company: "text",
    contact: "text",
    stage: { enum: ["researched", "contacted", "replied", "meeting", "won", "lost"] },
    owner: "person",
    lastTouched: { type: "date", optional: true },
  },
});
