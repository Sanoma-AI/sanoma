import { z } from "zod";
import { defineWorkflow } from "@sanoma-ai/workflows";
import { shop } from "../shop.ts";

/** Refunds an amount, in minor units. */
export default defineWorkflow({
  name: "refund",
  title: "Refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});
