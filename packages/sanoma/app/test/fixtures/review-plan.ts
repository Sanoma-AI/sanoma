import { defineWorkflow } from "sanoma/workflows";
import { z } from "zod";
import { PLAN } from "./apply-plan.ts";

/** Asks marketing-lead to approve `PLAN`, carried in the approval's details as apply's is, then returns it. */
export default defineWorkflow({
  name: "review-plan",
  trigger: "manual",
  input: z.object({}),
  uses: ["approval"],
  run: async (ctx) => {
    await ctx.approval("Apply the plan", { approver: "marketing-lead", details: JSON.stringify(PLAN) });
    return PLAN;
  },
});
