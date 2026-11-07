import { collection } from "sanoma/data";

/** Who bought something: `shop.customers`, beside the CRM's own customers. */
export const customers = collection({
  name: "customers",
  title: "Shop customers",
  key: "id",
  fields: {
    id: "text",
    email: "text",
  },
});
