import { defineWorkflow, z } from "sanoma";
import { customers as crm } from "../apps/crm/resources/data.ts";
import { customers as shop } from "../apps/shop/resources/data.ts";

/** The company's own glue between its two apps: a shop customer added to the CRM. */
export default defineWorkflow({
  name: "introduce",
  title: "Introduce a shop customer to the CRM",
  trigger: "manual",
  input: z.object({ id: z.string().min(1) }),
  uses: [shop.get, crm.save],
  run: async (ctx, { id }) => {
    const bought = await ctx.data.shop.customers.get({ key: id });
    if (bought) {
      await ctx.data.crm.customers.save({ record: { email: bought.record.email, name: bought.record.email } });
    }
    return { introduced: bought !== null };
  },
});
