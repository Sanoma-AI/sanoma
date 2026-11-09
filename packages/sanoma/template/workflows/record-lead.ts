import { defineWorkflow, z } from "sanoma";
import { outbound } from "../resources/data.ts";

/** Put a new lead on the Outbound board (resources/data.ts), at its first stage, owned by whoever recorded it. */
export default defineWorkflow({
  name: "record-lead",
  title: "Record a lead",
  trigger: "manual",
  input: z.object({
    /** The lead's company: its key on the board. */
    company: z.string().min(1),
    contact: z.string().min(1),
  }),
  uses: [outbound.save],
  run: async (ctx, { company, contact }) => {
    const saved = await ctx.data.outbound.save(
      {
        record: {
          company,
          contact,
          stage: "researched",
          owner: ctx.startedBy.id,
          lastTouched: new Date(await ctx.now()).toISOString(),
        },
      },
      { name: "Record the lead" },
    );
    return { company: saved.record.company, stage: saved.record.stage };
  },
});
