import { cleaningInvoice, InvoiceValidationError, petSittingInvoice } from "@sanoma-ai/invoices";
import { DriverError } from "@sanoma-ai/workflows";
import { InvoiceRenderError } from "@sanoma-ai/invoices/pdf-contract";
import { fileSchema, generateInput, workflowPdfLimits, type GenerateInput, type PdfFile } from "./connector.ts";

/** Shared by live and scenario drivers: this local computation needs no simulated vendor. */
export async function generate(input: GenerateInput): Promise<PdfFile> {
  const parsed = generateInput.safeParse(input);
  if (!parsed.success)
    throw new DriverError("Invalid invoice generation input", {
      retryable: false,
      vendorCode: "invalid_invoice",
      status: 422,
    });
  try {
    const request = parsed.data.document;
    const invoice =
      request.kind === "pet-sitting"
        ? petSittingInvoice(request.invoice)
        : request.kind === "cleaning"
          ? cleaningInvoice(request.invoice)
          : request.invoice;
    // Loading a connector's metadata must not initialize the PDF engine.
    const { renderInvoice } = await import("@sanoma-ai/invoices/node");
    const file = await renderInvoice(invoice, parsed.data.options);
    if (file.bytes.byteLength > workflowPdfLimits.bytes) throw tooLarge();
    const result = fileSchema.parse({
      mediaType: file.mediaType,
      filename: file.filename,
      byteLength: file.bytes.byteLength,
      base64: Buffer.from(file.bytes).toString("base64"),
      currency: invoice.currency,
      summary: file.summary,
    });
    if (Buffer.byteLength(JSON.stringify(result)) > workflowPdfLimits.jsonBytes) throw tooLarge();
    return result;
  } catch (error) {
    if (error instanceof DriverError) throw error;
    if (error instanceof InvoiceRenderError && error.code === "output_too_large") throw tooLarge();
    if (error instanceof InvoiceValidationError) {
      const fields = error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "invoice"}: ${issue.message}`)
        .join("; ");
      throw new DriverError(`Check the invoice fields: ${fields}`, {
        retryable: false,
        status: 422,
        vendorCode: "invalid_invoice",
      });
    }
    // Renderer failures, including malformed assets, never improve by automatically retrying.
    throw new DriverError("Invoice PDF generation failed; check the invoice size and content", {
      retryable: false,
      vendorCode: "render_failed",
    });
  }
}

function tooLarge() {
  return new DriverError("The invoice PDF exceeds the workflow's 1 MiB file limit", {
    retryable: false,
    vendorCode: "output_too_large",
  });
}
