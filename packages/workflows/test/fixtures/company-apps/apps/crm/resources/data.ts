import { collection } from "sanoma/data";

/** The people the CRM follows up with: `crm.customers`, beside the shop's own customers. */
export const customers = collection({
  name: "customers",
  title: "Customers",
  key: "email",
  fields: {
    email: "text",
    name: "text",
    followedUp: { type: "boolean", optional: true },
  },
});
