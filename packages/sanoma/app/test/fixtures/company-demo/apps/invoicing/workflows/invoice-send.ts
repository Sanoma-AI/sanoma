import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";
import { clients } from "../../../resources/data.ts";
import { invoices, sequence } from "../resources/data.ts";

/** Numbers a draft, emails it with its PDF attached, waits a week, and reminds the client while it is unpaid. */
export default defineWorkflow({
  name: "invoice-send",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [invoices.get, invoices.save, sequence.get, sequence.save, clients.get, resend.emails.send, "sleep"],
  run: async (ctx, { id }) => {
    const draft = await ctx.data.invoicing.invoices.get({ key: id });
    if (!draft) throw new Error(`No invoice ${id}`);
    const client = await ctx.data.clients.get({ key: draft.record.client });
    if (!client) throw new Error(`No client ${draft.record.client}`);
    const counter = await ctx.data.invoicing.sequence.get({ key: "invoice" });
    const next = counter?.record.next ?? 1;
    await ctx.data.invoicing.sequence.save({ record: { name: "invoice", next: next + 1 } });
    const number = `INV-${String(next).padStart(4, "0")}`;
    const email = (subject: string) => ({
      to: client.record.email,
      from: "Dana <billing@dana.example>",
      subject,
      text: `Invoice ${number}: ${draft.record.total}`,
      // The PDF, as the email carries it: base64, which the fake keeps as it is.
      attachments: [{ filename: `${number}.pdf`, content: btoa(`%PDF ${number}`) }],
    });
    await ctx.resend.emails.send(email(`Invoice ${number}`));
    await ctx.data.invoicing.invoices.save({ record: { ...draft.record, number, status: "sent" } });
    const sentAt = await ctx.now();
    await ctx.sleep({ days: 7 });
    const later = await ctx.data.invoicing.invoices.get({ key: id });
    const reminded = later?.record.status === "sent";
    if (reminded) await ctx.resend.emails.send(email(`Reminder: invoice ${number}`));
    return { number, reminded, waitedDays: ((await ctx.now()) - sentAt) / 86_400_000 };
  },
});
