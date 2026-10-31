import { renderInvoice } from "@sanoma-ai/invoices/browser";
import { cleaningInvoice, petSittingInvoice } from "@sanoma-ai/invoices";
import type { PdfOptions } from "@sanoma-ai/invoices/pdf";
import { commercialCleaningExample, petSittingExample, residentialCleaningExample } from "@sanoma-ai/invoices/examples";

const long = cleaningInvoice(commercialCleaningExample);
long.presentation.paper = "LETTER";
long.lines = Array.from({ length: 40 }, (_, i) => ({
  description: `Service ${i + 1}: ${"Detailed cleaning of work areas and meeting rooms. ".repeat(6)}`,
  quantity: "1",
  unitPrice: "120",
  unit: "visit",
  serviceDate: "2026-10-20",
}));
long.notes = "Final payment reference: OFFICE-001";
const french = cleaningInvoice(residentialCleaningExample);
french.currency = "EUR";
french.locale = "fr-FR";
french.lines = [{ description: "Nettoyage", quantity: "1", unit: "job", unitPrice: "1234.5678" }];
export const cases = [
  petSittingInvoice(petSittingExample),
  cleaningInvoice(residentialCleaningExample),
  cleaningInvoice(commercialCleaningExample),
  long,
  french,
];

async function run() {
  const results = [];
  for (const [index, input] of cases.entries()) {
    const options: PdfOptions =
      index === 4
        ? {
            logo: {
              mediaType: "image/png",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR4XmNYAAVwBgBaEgoBUJQjEgAAAABJRU5ErkJggg==",
            },
          }
        : {};
    const start = performance.now();
    const file = await renderInvoice(input, options);
    results.push({
      input,
      options,
      bytes: Array.from(file.bytes),
      summary: file.summary,
      filename: file.filename,
      milliseconds: performance.now() - start,
    });
  }
  return results;
}
declare global {
  interface Window {
    invoiceSmoke: typeof run;
  }
}
window.invoiceSmoke = run;
document.body.textContent = "Invoice renderer ready";
