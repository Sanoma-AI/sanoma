import { collection } from "sanoma/data";

/** The app's invoices, by id. */
export const invoices = collection({
  name: "invoices",
  key: "id",
  fields: {
    id: "text",
    number: { type: "text", optional: true },
    client: "text",
    status: { enum: ["draft", "sent", "paid"] },
    total: "text",
  },
});

/** The app's own bookkeeping, which no page reads: the next invoice number. */
export const sequence = collection({
  name: "sequence",
  key: "name",
  fields: { name: "text", next: "number" },
});
