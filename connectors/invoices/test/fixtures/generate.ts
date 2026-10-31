import { invoices } from "@sanoma-ai/connector-invoices";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "generate-invoice",
  title: "Generate an invoice PDF",
  trigger: "manual",
  input: z.object({ request: invoices.pdf.generate.input, review: z.boolean().default(false) }),
  uses: [invoices.pdf.generate, "approval"],
  run: async (ctx, { request, review }) => {
    const file = await ctx.invoices.pdf.generate(request);
    if (review) await ctx.approval("Review the invoice", { approver: "alice" });
    return file;
  },
});
