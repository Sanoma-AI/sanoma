import { defineOperation, z } from "sanoma";
import { customers } from "../resources/data.ts";

/** The CRM's own operation, `operations.crm.score.run`: how well the CRM knows someone. */
export default defineOperation({
  name: "score",
  input: z.object({ email: z.string().min(1) }),
  uses: [customers.get],
  run: async (ctx, { email }) => {
    const found = await ctx.data.crm.customers.get({ key: email });
    return { score: found === null ? 0 : found.record.followedUp ? 2 : 1 };
  },
});
