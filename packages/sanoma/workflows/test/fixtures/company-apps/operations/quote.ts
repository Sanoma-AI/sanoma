import { defineOperation, z } from "sanoma";
import { customers } from "../apps/shop/resources/data.ts";

/** The company's own logic, `operations.quote.run`: a shop customer pays less per item than someone new. */
export default defineOperation({
  name: "quote",
  description: "What an order of some items costs a shop customer",
  input: z.object({ id: z.string().min(1), items: z.number().int().positive() }),
  uses: [customers.get],
  run: async (ctx, { id, items }) => {
    const known = await ctx.data.shop.customers.get({ key: id });
    return { email: known?.record.email ?? null, total: items * (known ? 9 : 10) };
  },
});
