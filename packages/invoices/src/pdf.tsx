import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ComponentProps } from "react";
import { prepareInvoice, type PdfOptions } from "./render-contract.ts";
import { formatMoney, type CalculatedInvoice } from "./calculate.ts";
import { currencyPrecision, type InvoiceInput, type Invoice } from "./schema.ts";

export { pdfLimits, pdfOptionsSchema, InvoiceRenderError } from "./render-contract.ts";
export type { PdfOptions, InvoiceFile } from "./render-contract.ts";

const styles = StyleSheet.create({
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
});
function Words(props: ComponentProps<typeof Text>) {
  return <Text {...props} hyphenationCallback={(word) => (word.length > 24 ? word.match(/.{1,24}/g)! : [word])} />;
}
function Address({ value }: { value?: Invoice["serviceAddress"] }) {
  if (!value) return null;
  return (
    <Words>
      {[...value.lines, [value.city, value.region, value.postalCode].filter(Boolean).join(" "), value.country]
        .filter(Boolean)
        .join("\n")}
    </Words>
  );
}
function Party({ title, value }: { title: string; value: Invoice["issuer"] }) {
  return (
    <View style={styles.party}>
      <Words style={styles.label}>{title}</Words>
      <Words style={styles.bold}>{value.name}</Words>
      <Address value={value.address} />
      {value.email && <Words>{value.email}</Words>}
      {value.phone && <Words>{value.phone}</Words>}
    </View>
  );
}

/** Internal layout only receives calculated data and sanitized assets. */
function InvoiceLayout({ calculated, logo }: { calculated: CalculatedInvoice; logo?: string }) {
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
  return (
    <Document
      title={`Invoice ${invoice.number}`}
      author={invoice.issuer.name}
      creator="Sanoma invoice tools"
      creationDate={date}
      modificationDate={date}
    >
      <Page size={invoice.presentation.paper} style={styles.page} wrap>
        <View style={[styles.header, accent]} fixed>
          <Words style={styles.issuer}>{invoice.issuer.name}</Words>
          {logo ? <Image style={styles.logo} src={logo} /> : <Words style={styles.muted}>{invoice.number}</Words>}
        </View>
        <View style={styles.intro} wrap={false}>
          <View>
            <Words style={styles.title}>Invoice</Words>
            <Words>{invoice.number}</Words>
            <Words style={styles.muted}>Issued {invoice.issuedOn}</Words>
            {invoice.dueOn && <Words style={styles.muted}>Due {invoice.dueOn}</Words>}
          </View>
          <View style={styles.right}>
            <Words style={styles.muted}>Balance due · {invoice.currency}</Words>
            <Words style={[styles.due, { fontSize: money(totals.dueMinor).length > 18 ? 18 : 24 }]}>
              {money(totals.dueMinor)}
            </Words>
          </View>
        </View>
        <View style={styles.parties}>
          <Party title="From" value={invoice.issuer} />
          <Party title="Bill to" value={invoice.recipient} />
        </View>
        {invoice.serviceAddress && (
          <View style={styles.detail} wrap={false}>
            <Words style={styles.label}>Service address</Words>
            <Address value={invoice.serviceAddress} />
          </View>
        )}
        {invoice.servicePeriod && (
          <Words style={styles.detail}>
            Service period: {invoice.servicePeriod.start} to {invoice.servicePeriod.end}
          </Words>
        )}
        {invoice.details?.map((detail, index) => (
          <View key={index} style={styles.detail}>
            <Words style={styles.label} minPresenceAhead={20}>
              {detail.label}
            </Words>
            <Words>{detail.value}</Words>
          </View>
        ))}
        <View style={styles.columns} fixed>
          <Words style={styles.description}>Service</Words>
          <Words style={styles.quantity}>Quantity</Words>
          <Words style={styles.rate}>Unit price</Words>
          <Words style={styles.amount}>Amount</Words>
        </View>
        {lines.map((line, index) => (
          <View key={index} style={styles.row} wrap={false}>
            <View style={styles.description}>
              <Words>{line.description}</Words>
              {line.serviceDate && <Words style={styles.muted}>{line.serviceDate}</Words>}
            </View>
            <Words style={styles.quantity}>
              {line.quantity} {line.unit}
              {Number(line.quantity) === 1 ? "" : "s"}
            </Words>
            <Words style={styles.rate}>{unitPrice(line.unitPrice)}</Words>
            <Words style={styles.amount}>{money(line.amountMinor)}</Words>
          </View>
        ))}
        <View style={styles.totals} wrap={false}>
          {[
            ["Subtotal", totals.subtotalMinor],
            ["Discount", -totals.discountMinor],
            [`Tax (${invoice.taxPercent}%)`, totals.taxMinor],
            ["Total", totals.totalMinor],
            ["Paid", -totals.paidMinor],
          ].map(([label, value]) => (
            <View key={label} style={styles.totalRow}>
              <Words>{label}</Words>
              <Words>
                {Number(value) < 0 ? "-" : ""}
                {money(Math.abs(Number(value)))}
              </Words>
            </View>
          ))}
          <View style={[styles.totalRow, styles.balance, accent]}>
            <Words>Balance due</Words>
            <Words>{money(totals.dueMinor)}</Words>
          </View>
        </View>
        {invoice.notes && (
          <View>
            <Words style={styles.label} minPresenceAhead={20}>
              Notes
            </Words>
            <Words>{invoice.notes}</Words>
          </View>
        )}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

/** Creates the shared React document after validating data, glyphs, bounds and logo bytes. */
export function createInvoiceDocument(input: InvoiceInput, options?: PdfOptions) {
  const prepared = prepareInvoice(input, options);
  return { document: InvoiceLayout(prepared), filename: prepared.filename, summary: prepared.calculated.totals };
}

/** Safe declarative entry point for applications composing React PDF documents. */
export function InvoiceDocument({ input, options }: { input: InvoiceInput; options?: PdfOptions }) {
  return createInvoiceDocument(input, options).document;
}
