import { pdf } from "@react-pdf/renderer";
import { createInvoiceDocument } from "./pdf.tsx";
import { invoiceFile, InvoiceRenderError, type PdfOptions } from "./render-contract.ts";
import type { InvoiceInput } from "./schema.ts";

export { InvoiceRenderError } from "./render-contract.ts";
export type { InvoiceFile, PdfOptions } from "./render-contract.ts";

export async function renderInvoice(input: InvoiceInput, options?: PdfOptions) {
  const prepared = createInvoiceDocument(input, options);
  try {
    const blob = await pdf(prepared.document).toBlob();
    return invoiceFile(new Uint8Array(await blob.arrayBuffer()), prepared);
  } catch (error) {
    if (error instanceof InvoiceRenderError) throw error;
    throw new InvoiceRenderError("render_failed");
  }
}
