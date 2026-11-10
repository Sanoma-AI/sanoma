import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";
import { collection } from "sanoma/data";
import { pageRuntime } from "sanoma/workflows/page";

// A page's entry, as a demo's build makes one: a collection, a workflow that reads it, sends an
// email through Resend's fake and sleeps a week, and the page runtime over them, seeded.
const invoices = collection({ name: "invoices", key: "number", fields: { number: "text", customer: "text" } });

const send = defineWorkflow({
  name: "send-invoice",
  trigger: "manual",
  input: z.object({ number: z.string() }),
  uses: [invoices.get, resend.emails.send, "sleep"],
  run: async (ctx, { number }) => {
    const found = await ctx.data.invoices.get({ key: number });
    if (!found) throw new Error(`No invoice ${number}`);
    const { id } = await ctx.resend.emails.send({
      to: found.record.customer,
      from: "Acme <billing@acme.example>",
      subject: `Invoice ${number}`,
      text: "Your invoice is attached.",
    });
    await ctx.sleep({ days: 7 });
    return { id, at: await ctx.now() };
  },
});

export const page = pageRuntime({
  workflows: [send],
  collections: [invoices],
  connectors: [resend],
  world: {
    name: "An invoice to send",
    given: [
      {
        step: 'Given data.invoices "INV-1" has',
        op: "data.invoices.save",
        input: { record: { number: "INV-1", customer: "ada@example.com" } },
      },
    ],
  },
});
