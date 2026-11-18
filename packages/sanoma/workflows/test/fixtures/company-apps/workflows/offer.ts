import { defineWorkflow, z } from "sanoma";
import score from "../apps/crm/operations/score.ts";
import quote from "../operations/quote.ts";

/** A quote for a shop customer, with the CRM's score of them: the company's operations as steps. */
export default defineWorkflow({
  name: "offer",
  title: "Offer a quote",
  trigger: "manual",
  input: z.object({ id: z.string().min(1), items: z.number().int().positive() }),
  uses: [quote, score],
  run: async (ctx, { id, items }) => {
    const quoted = await ctx.operations.quote.run({ id, items });
    let rank = 0;
    if (quoted.email !== null) rank = (await ctx.operations.crm.score.run({ email: quoted.email })).score;
    return { total: quoted.total, score: rank };
  },
});
