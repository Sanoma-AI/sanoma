import { defineSteps } from "@sanoma-ai/workflows";
import { invoicesOps } from "./connector.ts";

export const invoicesSteps = defineSteps("invoices", ({ then }) => {
  then("an invoice PDF was generated for {string}", (number: string) => ({
    op: invoicesOps.pdf.generate,
    called: true,
    check: (run) =>
      run.calls(invoicesOps.pdf.generate).some((call) => call.input.document.invoice.number === number)
        ? undefined
        : `No invoice PDF was generated for ${number}`,
  }));
});
