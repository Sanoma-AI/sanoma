// `sanoma/invoices/pdf`: an invoice as a PDF file, one `renderInvoice` in Node and in a browser.
// React-pdf picks its own build for each (its `browser` field), and loads at the first render: a
// module that imports this one (a workflow's file, which the worker and `check` load) loads no PDF
// engine, and a company that never renders installs none. Plain `createElement`, no JSX: the worker
// loads this package's source with Node's type stripping, which reads no `.tsx`.
import type { ComponentProps, ReactNode } from "react";
import { createElement as h } from "react";
import { formatMoney } from "./calculate.ts";
import {
  invoiceFile,
  InvoiceRenderError,
  prepareInvoice,
  type InvoiceFile,
  type PdfOptions,
} from "./render-contract.ts";
import { currencyPrecision, type Invoice, type InvoiceInput } from "./schema.ts";

export { InvoiceRenderError, pdfLimits, pdfOptionsSchema } from "./render-contract.ts";
export type { InvoiceFile, PdfOptions } from "./render-contract.ts";

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
  quantity: { width: "17%", textAlign: "right", paddingRight: 10, fontSize: 8 },
  rate: { width: "17%", textAlign: "right", paddingRight: 10, fontSize: 8 },
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
        words({ style: styles.quantity }, "Quantity"),
        words({ style: styles.rate }, "Unit price"),
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
          words({ style: styles.quantity }, `${line.quantity} ${line.unit}${Number(line.quantity) === 1 ? "" : "s"}`),
          words({ style: styles.rate }, unitPrice(line.unitPrice)),
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
  try {
    const blob = await renderer.pdf(invoiceDocument(renderer, prepared)).toBlob();
    return invoiceFile(new Uint8Array(await blob.arrayBuffer()), {
      filename: prepared.filename,
      summary: prepared.calculated.totals,
    });
  } catch (error) {
    if (error instanceof InvoiceRenderError) throw error;
    throw new InvoiceRenderError("render_failed");
  }
}
