import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, errorBodyOf } from "sanoma/site";
import { toast } from "sanoma/ui";

export const Route = createFileRoute("/sites/invoicing/invoicing/tool")({ component: Tool });

/** Sends the draft through the page's `api` and says where the run rests, as a run card reads it; renders a PDF in the page. */
function Tool() {
  const [said, say] = useState("");
  const send = async (id: string) => {
    try {
      const { runId } = await api.invoicingInvoiceSend.start({ id });
      // Its records read until it rests at its sleep, as the app's run card reads them, or ends.
      let ledger = await api.invoicingInvoiceSend.ledger(runId);
      while (!["sleep.started", "run.finished", "run.failed"].includes(ledger.at(-1)?.type ?? "")) {
        await new Promise((done) => setTimeout(done, 20));
        ledger = await api.invoicingInvoiceSend.ledger(runId);
      }
      // A failed run's `.result` throws its error.
      if (ledger.at(-1)?.type === "run.failed") await api.invoicingInvoiceSend.result(runId);
      const emails = ledger.filter((r) => r.type === "op.called" && r.op === "resend.emails.send").length;
      const invoice = await api.data.invoicing.invoices.get({ key: id });
      say(`Sent ${invoice?.record.number}, ${emails} email, resting at ${ledger.at(-1)?.type}`);
    } catch (err) {
      say(`Refused: ${errorBodyOf(err)?.error ?? String(err)}`);
    }
  };
  const render = async () => {
    const { renderInvoice } = await import("sanoma/invoices/pdf");
    const file = await renderInvoice({
      number: "INV-0001",
      issuedOn: "2026-11-10",
      currency: "USD",
      issuer: { name: "Dana's Pet Care", email: "dana@dana.example" },
      recipient: { name: "Ada Ortiz" },
      lines: [{ description: "Walk", unit: "visit", quantity: "2", unitPrice: "25" }],
    });
    say(`PDF ${file.filename} ${file.bytes.length > 1000 ? "rendered" : "empty"}`);
  };
  return (
    <section className="flex flex-col gap-2">
      <button type="button" onClick={() => send("draft-1")}>
        Send draft-1
      </button>
      <button type="button" onClick={() => send("nothing")}>
        Send nothing
      </button>
      <button type="button" onClick={render}>
        Render a PDF
      </button>
      <button type="button" onClick={() => toast.success("Toasted")}>
        Toast
      </button>
      <output>{said}</output>
    </section>
  );
}
