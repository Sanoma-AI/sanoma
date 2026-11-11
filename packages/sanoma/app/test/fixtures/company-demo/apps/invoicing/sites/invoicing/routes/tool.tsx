import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, errorBodyOf } from "sanoma/site";
import { toast } from "sanoma/ui";

export const Route = createFileRoute("/sites/invoicing/invoicing/tool")({ component: Tool });

/** Sends the draft through the page's `api` and says what came back; renders a PDF in the page. */
function Tool() {
  const [said, say] = useState("");
  const send = async (id: string) => {
    try {
      const sent = await api.invoicingInvoiceSend({ id });
      say(`Sent ${sent.number}, reminded ${sent.reminded} after ${sent.waitedDays} days`);
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
