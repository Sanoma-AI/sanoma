import { cleaningSchema, currencySchema, invoiceSchema, petSittingSchema } from "@sanoma-ai/invoices";
import { pdfOptionsSchema } from "@sanoma-ai/invoices/pdf-contract";
import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/** A smaller limit than the renderer's, because checkpoints store base64 in JSON. */
export const workflowPdfLimits = { bytes: 1024 * 1024, jsonBytes: 1_400_000 } as const;
const documentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("invoice"), invoice: invoiceSchema }),
  z.strictObject({ kind: z.literal("pet-sitting"), invoice: petSittingSchema }),
  z.strictObject({ kind: z.literal("cleaning"), invoice: cleaningSchema }),
]);
export const generateInput = z.strictObject({ document: documentSchema, options: pdfOptionsSchema.optional() });
const minor = z.int().nonnegative();
export const fileSchema = z
  .strictObject({
    mediaType: z.literal("application/pdf"),
    filename: z
      .string()
      .max(92)
      .regex(/^invoice-[a-zA-Z0-9_-]+\.pdf$/),
    byteLength: z.int().positive().max(workflowPdfLimits.bytes),
    base64: z
      .string()
      .max(Math.ceil(workflowPdfLimits.bytes / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    currency: currencySchema,
    summary: z.strictObject({
      subtotalMinor: minor,
      discountMinor: minor,
      taxableMinor: minor,
      taxMinor: minor,
      totalMinor: minor,
      paidMinor: minor,
      dueMinor: minor,
      precision: z.union([z.literal(0), z.literal(2), z.literal(3)]),
    }),
  })
  .refine(
    (file) =>
      (file.base64.length / 4) * 3 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0) ===
      file.byteLength,
    "PDF byte length does not match base64",
  );
export type GenerateInput = z.input<typeof generateInput>;
export type PdfFile = z.output<typeof fileSchema>;

export const invoicesOps = defineConnector(
  "invoices",
  {
    pdf: {
      generate: {
        effect: "read",
        idempotent: true,
        description:
          "Generate an invoice PDF locally from explicit invoice data. Does not save, number, send, or collect payment.",
        input: generateInput,
        output: fileSchema,
        target: ({ document }: { document: { invoice: { number: string } } }) =>
          `invoice/${encodeURIComponent(document.invoice.number)}`,
        // The durable result retains the bytes; the ledger need not duplicate them or an input logo.
        opaque: ["base64", "options"],
      },
    },
  },
  vendorInfo(import.meta.url),
);
