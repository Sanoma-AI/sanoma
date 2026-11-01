import { renderToBuffer } from "@react-pdf/renderer";
import { createInvoiceDocument } from "./pdf.tsx";
import { invoiceFile, InvoiceRenderError, type PdfOptions } from "./render-contract.ts";
import type { InvoiceInput } from "./schema.ts";

export { InvoiceRenderError } from "./render-contract.ts";
export type { InvoiceFile, PdfOptions } from "./render-contract.ts";

export async function renderInvoice(input: InvoiceInput, options?: PdfOptions) {
  const prepared = createInvoiceDocument(input, options);
  try {
    const bytes = new Uint8Array(await renderToBuffer(prepared.document));
    return invoiceFile(bytes, prepared);
  } catch (error) {
    if (error instanceof InvoiceRenderError) throw error;
    throw new InvoiceRenderError("render_failed");
  }
}
