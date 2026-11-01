import { renderInvoice as render } from "../../../invoices/src/browser.ts";

// Test-only delayed completion, after rendering the actual PDF. Production uses the package directly.
export async function renderInvoice(invoice, options) {
  const delay = window.invoiceRenderDelays?.shift() ?? 0;
  window.invoiceRenderEvents ??= [];
  window.invoiceRenderEvents.push({ number: invoice.number, event: "started" });
  const file = await render(invoice, options);
  if (delay) await new Promise((done) => setTimeout(done, delay));
  window.invoiceRenderEvents.push({ number: invoice.number, event: "finished" });
  return file;
}
