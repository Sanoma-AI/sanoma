import { collection } from "sanoma/data";

/** The company's clients, by name: an invoice is for one. */
export const clients = collection({
  name: "clients",
  key: "name",
  fields: { name: "text", email: "text" },
});
