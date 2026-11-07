import { defineWorkflow, z } from "sanoma";
import { customers } from "../resources/data.ts";

/** The shop's own `follow-up`, `shop.follow-up`: the same name as the CRM's, in another app. */
export default defineWorkflow({
  name: "follow-up",
  title: "Thank a customer",
  trigger: "manual",
  input: z.object({ id: z.string().min(1) }),
  uses: [customers.get],
  run: async (ctx, { id }) => {
    const found = await ctx.data.shop.customers.get({ key: id });
    return { email: found?.record.email ?? null };
  },
});
