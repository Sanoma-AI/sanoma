import { z } from "zod";
import { defineWorkflow } from "../../../../src/index.ts";
import { outbound } from "../resources/data.ts";

/** Moves a company's lead on to contacted, and says who saved it; a company with no lead is left alone. */
export default defineWorkflow({
  name: "outbound-next",
  title: "Move a lead on",
  trigger: "manual",
  input: z.object({ company: z.string().min(1) }),
  uses: [outbound.get, outbound.save],
  run: async (ctx, { company }) => {
    const lead = await ctx.data.outbound.get({ key: company });
    let by: string | null = null;
    if (lead) {
      const saved = await ctx.data.outbound.save({ record: { ...lead.record, stage: "contacted" } });
      by = saved.updatedBy;
    }
    return by;
  },
});
