import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";
import { invoiceSchema } from "sanoma/invoices";
import { renderInvoice } from "sanoma/invoices/pdf";

/** A company's workflow: the invoice rendered as a plain function, and emailed through Resend with the PDF attached. */
export default defineWorkflow({
  name: "send-invoice",
  title: "Send an invoice",
  trigger: "manual",
  input: z.object({ invoice: invoiceSchema, to: z.string() }),
  uses: [resend.emails.send],
  run: async (ctx, { invoice, to }) => {
    const file = await renderInvoice(invoice);
    return ctx.resend.emails.send({
      to,
      from: `${invoice.issuer.name} <billing@example.com>`,
      subject: `Invoice ${invoice.number}`,
      text: "Your invoice is attached.",
      attachments: [{ filename: file.filename, content: Buffer.from(file.bytes).toString("base64") }],
    });
  },
});
