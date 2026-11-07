import { defineWorkflow, z } from "sanoma";
import { customers } from "../resources/data.ts";

/** Marks a customer followed up: `crm.follow-up`, reading and saving `crm.customers`. */
export default defineWorkflow({
  name: "follow-up",
  title: "Follow up",
  trigger: "manual",
  input: z.object({ email: z.string().min(1) }),
  uses: [customers.get, customers.save],
  run: async (ctx, { email }) => {
    const found = await ctx.data.crm.customers.get({ key: email });
    if (found) await ctx.data.crm.customers.save({ record: { ...found.record, followedUp: true } });
    return { followedUp: found !== null };
  },
});
