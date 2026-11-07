import { collection } from "@sanoma-ai/workflows/data";

/** The outbound pipeline: which lead is at which stage, and who owns it. */
export const outbound = collection({
  name: "outbound",
  title: "Outbound",
  key: "company",
  fields: {
    company: "text",
    contact: "text",
    stage: { enum: ["researched", "contacted", "replied", "meeting", "won", "lost"] },
    owner: "person",
    lastTouched: { type: "date", optional: true },
    seats: { type: "number", optional: true },
  },
});
