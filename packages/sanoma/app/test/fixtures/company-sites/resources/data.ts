import { collection } from "sanoma/data";

/** The leads the hello site lists. */
export const leads = collection({
  name: "leads",
  key: "company",
  fields: { company: "text", stage: "text" },
});
