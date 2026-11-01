import { z } from "zod";
import { calculateInvoice, InvoiceValidationError, type InvoiceIssue, type InvoiceTotals } from "./calculate.ts";
import { validateLogo } from "./logo.ts";
export { validateLogo } from "./logo.ts";

export const pdfLimits = {
  lines: 100,
  textCharacters: 30_000,
  descriptionLines: 40,
  logoBytes: 256 * 1024,
  logoDimension: 1024,
  outputBytes: 5 * 1024 * 1024,
} as const;
export const pdfOptionsSchema = z.strictObject({
  logo: z
    .strictObject({ mediaType: z.literal("image/png"), base64: z.string().max(Math.ceil(pdfLimits.logoBytes / 3) * 4) })
    .optional(),
});
export type PdfOptions = z.input<typeof pdfOptionsSchema>;
export interface InvoiceFile {
  bytes: Uint8Array;
  mediaType: "application/pdf";
  filename: string;
  summary: InvoiceTotals;
}
export class InvoiceRenderError extends Error {
  readonly code: "render_failed" | "output_too_large";
  constructor(code: "render_failed" | "output_too_large") {
    super(
      code === "output_too_large"
        ? "The generated PDF exceeds 5 MiB. Reduce the invoice size."
        : "PDF generation failed. Try again or simplify the invoice.",
    );
    this.name = "InvoiceRenderError";
    this.code = code;
  }
}

// Explicit WinAnsi subset supported by the built-in Helvetica fonts. No font fetches.
const supportedText =
  /^[\t\r\n\x20-\x7e\xa0-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]*$/;

export function prepareInvoice(input: unknown, options: unknown = {}) {
  const calculated = calculateInvoice(input);
  const parsed = pdfOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new InvoiceValidationError(
      parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    );
  const issues: InvoiceIssue[] = [];
  let characters = 0;
  function inspect(value: unknown, path: InvoiceIssue["path"]) {
    if (typeof value === "string") {
      characters += value.length;
      if (!supportedText.test(value))
        issues.push({
          code: "unsupported_text",
          path,
          message:
            "Use Western European letters and punctuation; this PDF font does not support emoji or other scripts.",
        });
      const multiline =
        path[0] === "notes" ||
        (path[0] === "details" && path[2] === "value") ||
        (path[0] === "lines" && path[2] === "description");
      if (!multiline && /[\r\n\t]/.test(value))
        issues.push({ code: "multiline_field", path, message: "Keep this field on one line." });
    } else if (Array.isArray(value)) value.forEach((item, i) => inspect(item, [...path, i]));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, item]) => inspect(item, [...path, key]));
  }
  inspect(calculated.invoice, []);
  calculated.lines.forEach((line, index) => {
    // Conservative bound keeps an unbroken service row shorter than a continuation page.
    const estimatedLines = line.description
      .split(/\r\n?|\n/)
      .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / 20)), 0);
    if (estimatedLines > pdfLimits.descriptionLines)
      issues.push({
        code: "description_too_long",
        path: ["lines", index, "description"],
        message: "Shorten this service description or move the extra detail into Notes.",
      });
  });
  if (calculated.lines.length > pdfLimits.lines)
    issues.push({ code: "too_many_lines", path: ["lines"], message: "A PDF supports up to 100 service lines." });
  if (characters > pdfLimits.textCharacters)
    issues.push({ code: "too_much_text", path: [], message: "Keep the invoice below 30,000 text characters." });
  if (issues.length) throw new InvoiceValidationError(issues);
  const logo = parsed.data.logo ? validateLogo(parsed.data.logo.base64) : undefined;
  const slug =
    calculated.invoice.number
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "invoice";
  return { calculated, logo, filename: `invoice-${slug}.pdf` };
}

export function invoiceFile(bytes: Uint8Array, prepared: { filename: string; summary: InvoiceTotals }): InvoiceFile {
  if (bytes.byteLength > pdfLimits.outputBytes) throw new InvoiceRenderError("output_too_large");
  return { bytes, filename: prepared.filename, mediaType: "application/pdf", summary: prepared.summary };
}
