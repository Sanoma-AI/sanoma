// `sanoma/invoices/pdf`: an invoice as a PDF file, one `renderInvoice` in Node and in a browser.
// React-pdf picks its own build for each (its `browser` field), and loads at the first render: a
// module that imports this one (a workflow's file, which the worker and `check` load) loads no PDF
// engine, and a company that never renders installs none. Plain `createElement`, no JSX: the worker
// loads this package's source with Node's type stripping, which reads no `.tsx`.
import type { ComponentProps, ReactNode } from "react";
import { createElement as h } from "react";
import { z } from "zod";
import {
  calculateInvoice,
  formatMoney,
  InvoiceValidationError,
  validated,
  type InvoiceIssue,
  type InvoiceTotals,
} from "./calculate.ts";
import { validateLogo } from "./logo.ts";
import { currencyPrecision, type Invoice, type InvoiceInput } from "./schema.ts";

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

/** The invoice calculated and checked for the PDF: its glyphs, its bounds, its logo and its file name. */
function prepareInvoice(input: unknown, options: unknown = {}) {
  const calculated = calculateInvoice(input);
  const { logo: png } = validated(pdfOptionsSchema, options);
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
  const logo = png ? validateLogo(png.base64) : undefined;
  const slug =
    calculated.invoice.number
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "invoice";
  return { calculated, logo, filename: `invoice-${slug}.pdf` };
}

type Renderer = typeof import("@react-pdf/renderer");

// React-pdf's `StyleSheet.create` returns its argument; a plain object needs no renderer loaded.
const styles = {
  page: {
    // Do not inherit numeric lineHeight here: repeated layout passes in React-pdf 4.9
    // multiply it again, moving fixed footers off-page and overflowing long invoices.
    paddingTop: 36,
    paddingBottom: 50,
    paddingHorizontal: 40,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#202b28",
  },
  header: {
    flexDirection: "row",
    flexShrink: 0,
    justifyContent: "space-between",
    borderBottomWidth: 2,
    paddingBottom: 12,
    marginBottom: 22,
  },
  issuer: { fontSize: 13, fontFamily: "Helvetica-Bold", maxWidth: "72%" },
  logo: { width: 58, height: 40, objectFit: "contain" },
  intro: { flexDirection: "row", flexShrink: 0, justifyContent: "space-between", marginBottom: 24 },
  title: { fontSize: 32, fontFamily: "Helvetica-Bold", lineHeight: 1.1 },
  muted: { color: "#52635c", fontSize: 9 },
  due: { fontSize: 24, fontFamily: "Helvetica-Bold", marginTop: 3 },
  right: { textAlign: "right" },
  parties: { flexDirection: "row", flexShrink: 0, gap: 24, marginBottom: 18 },
  party: { width: "48%" },
  label: { color: "#52635c", fontSize: 9, marginBottom: 4 },
  bold: { fontFamily: "Helvetica-Bold" },
  detail: { marginBottom: 10 },
  columns: {
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: "#edf2ef",
    padding: 8,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
  },
  row: {
    flexDirection: "row",
    flexShrink: 0,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dce4df",
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  description: { width: "48%", paddingRight: 12 },
  figure: { width: "17%", textAlign: "right", paddingRight: 10, fontSize: 8 },
  amount: { width: "18%", textAlign: "right", fontSize: 8 },
  totals: { width: "50%", marginLeft: "50%", marginTop: 18, marginBottom: 20 },
  totalRow: { flexDirection: "row", flexShrink: 0, justifyContent: "space-between", gap: 12, marginBottom: 5 },
  balance: { borderTopWidth: 2, paddingTop: 10, marginTop: 5, fontSize: 12, fontFamily: "Helvetica-Bold" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#52635c", textAlign: "right" },
} as const;

/** Breaks a word longer than 24 characters, which would otherwise run off the page. */
const hyphenate = (word: string) => (word.length > 24 ? word.match(/.{1,24}/g)! : [word]);

/** The document, from calculated data and a sanitized logo only. */
function invoiceDocument(
  { Document, Image, Page, Text, View }: Renderer,
  { calculated, logo }: ReturnType<typeof prepareInvoice>,
) {
  const words = (props: ComponentProps<typeof Text>, ...children: ReactNode[]) =>
    h(Text, { ...props, hyphenationCallback: hyphenate }, ...children);
  const address = (value: Invoice["serviceAddress"]) =>
    value &&
    words(
      {},
      [...value.lines, [value.city, value.region, value.postalCode].filter(Boolean).join(" "), value.country]
        .filter(Boolean)
        .join("\n"),
    );
  const party = (title: string, value: Invoice["issuer"]) =>
    h(
      View,
      { style: styles.party },
      words({ style: styles.label }, title),
      words({ style: styles.bold }, value.name),
      address(value.address),
      value.email && words({}, value.email),
      value.phone && words({}, value.phone),
    );

  const { invoice, lines, totals } = calculated;
  // French Intl formatting uses a narrow NBSP absent from Helvetica's WinAnsi set.
  const money = (minor: number) => formatMoney(minor, invoice.currency, invoice.locale).replaceAll("\u202f", "\u00a0");
  const unitPrice = (decimal: string) => {
    const [whole, fraction = ""] = decimal.split(".");
    const digits = Math.max(currencyPrecision[invoice.currency], fraction.length);
    return new Intl.NumberFormat(invoice.locale, {
      style: "currency",
      currency: invoice.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
      .formatToParts(BigInt(whole!))
      .map((part) => (part.type === "fraction" ? fraction.padEnd(digits, "0") : part.value))
      .join("")
      .replaceAll("\u202f", "\u00a0");
  };
  const accent = { borderColor: invoice.presentation.accent };
  const date = new Date(`${invoice.issuedOn}T00:00:00.000Z`);
  return h(
    Document,
    {
      title: `Invoice ${invoice.number}`,
      author: invoice.issuer.name,
      creator: "Sanoma invoice tools",
      creationDate: date,
      modificationDate: date,
    },
    h(
      Page,
      { size: invoice.presentation.paper, style: styles.page, wrap: true },
      h(
        View,
        { style: [styles.header, accent], fixed: true },
        words({ style: styles.issuer }, invoice.issuer.name),
        logo ? h(Image, { style: styles.logo, src: logo }) : words({ style: styles.muted }, invoice.number),
      ),
      h(
        View,
        { style: styles.intro, wrap: false },
        h(
          View,
          null,
          words({ style: styles.title }, "Invoice"),
          words({}, invoice.number),
          words({ style: styles.muted }, `Issued ${invoice.issuedOn}`),
          invoice.dueOn && words({ style: styles.muted }, `Due ${invoice.dueOn}`),
        ),
        h(
          View,
          { style: styles.right },
          words({ style: styles.muted }, `Balance due · ${invoice.currency}`),
          words(
            { style: [styles.due, { fontSize: money(totals.dueMinor).length > 18 ? 18 : 24 }] },
            money(totals.dueMinor),
          ),
        ),
      ),
      h(View, { style: styles.parties }, party("From", invoice.issuer), party("Bill to", invoice.recipient)),
      invoice.serviceAddress &&
        h(
          View,
          { style: styles.detail, wrap: false },
          words({ style: styles.label }, "Service address"),
          address(invoice.serviceAddress),
        ),
      invoice.servicePeriod &&
        words(
          { style: styles.detail },
          `Service period: ${invoice.servicePeriod.start} to ${invoice.servicePeriod.end}`,
        ),
      invoice.details?.map((detail, index) =>
        h(
          View,
          { key: index, style: styles.detail },
          words({ style: styles.label, minPresenceAhead: 20 }, detail.label),
          words({}, detail.value),
        ),
      ),
      h(
        View,
        { style: styles.columns, fixed: true },
        words({ style: styles.description }, "Service"),
        words({ style: styles.figure }, "Quantity"),
        words({ style: styles.figure }, "Unit price"),
        words({ style: styles.amount }, "Amount"),
      ),
      lines.map((line, index) =>
        h(
          View,
          { key: index, style: styles.row, wrap: false },
          h(
            View,
            { style: styles.description },
            words({}, line.description),
            line.serviceDate && words({ style: styles.muted }, line.serviceDate),
          ),
          words({ style: styles.figure }, `${line.quantity} ${line.unit}${Number(line.quantity) === 1 ? "" : "s"}`),
          words({ style: styles.figure }, unitPrice(line.unitPrice)),
          words({ style: styles.amount }, money(line.amountMinor)),
        ),
      ),
      h(
        View,
        { style: styles.totals, wrap: false },
        (
          [
            ["Subtotal", totals.subtotalMinor],
            ["Discount", -totals.discountMinor],
            [`Tax (${invoice.taxPercent}%)`, totals.taxMinor],
            ["Total", totals.totalMinor],
            ["Paid", -totals.paidMinor],
          ] as const
        ).map(([label, value]) =>
          h(
            View,
            { key: label, style: styles.totalRow },
            words({}, label),
            words({}, `${value < 0 ? "-" : ""}${money(Math.abs(value))}`),
          ),
        ),
        h(
          View,
          { style: [styles.totalRow, styles.balance, accent] },
          words({}, "Balance due"),
          words({}, money(totals.dueMinor)),
        ),
      ),
      invoice.notes &&
        h(View, null, words({ style: styles.label, minPresenceAhead: 20 }, "Notes"), words({}, invoice.notes)),
      h(Text, {
        style: styles.footer,
        fixed: true,
        render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );
}

/**
 * The invoice as a PDF file, after validating its data, glyphs, bounds and logo: an
 * `InvoiceValidationError` for the input, an `InvoiceRenderError` for the render, never a partial file.
 */
export async function renderInvoice(input: InvoiceInput, options?: PdfOptions): Promise<InvoiceFile> {
  const prepared = prepareInvoice(input, options);
  let renderer: Renderer;
  try {
    renderer = await import("@react-pdf/renderer");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      "renderInvoice needs @react-pdf/renderer: install it beside sanoma (`pnpm add @react-pdf/renderer`)",
      { cause: error },
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await (await renderer.pdf(invoiceDocument(renderer, prepared)).toBlob()).arrayBuffer());
  } catch {
    throw new InvoiceRenderError("render_failed");
  }
  if (bytes.byteLength > pdfLimits.outputBytes) throw new InvoiceRenderError("output_too_large");
  return { bytes, filename: prepared.filename, mediaType: "application/pdf", summary: prepared.calculated.totals };
}
