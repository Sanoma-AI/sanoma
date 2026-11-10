import { currencyPrecision, invoiceSchema, type Currency, type Invoice, type InvoiceLine } from "./schema.ts";

export interface InvoiceIssue {
  code: string;
  path: (string | number)[];
  message: string;
}

/** Serializable errors for forms and operation adapters; input values are not included. */
export class InvoiceValidationError extends Error {
  readonly code = "invalid_invoice";
  readonly issues: InvoiceIssue[];
  constructor(issues: InvoiceIssue[]) {
    super("Check the invoice fields");
    this.name = "InvoiceValidationError";
    this.issues = issues;
  }
}

export interface CalculatedLine extends InvoiceLine {
  amountMinor: number;
}
export interface InvoiceTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  precision: number;
}
export interface CalculatedInvoice {
  invoice: Invoice;
  lines: CalculatedLine[];
  totals: InvoiceTotals;
}

function decimal(value: string): [bigint, bigint] {
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
}
/** Non-negative rational, rounded half up exactly once to the currency's minor unit. */
const round = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
function fail(path: InvoiceIssue["path"], code: string, message: string): never {
  throw new InvoiceValidationError([{ path, code, message }]);
}
function safe(value: bigint, path: InvoiceIssue["path"]): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail(path, "amount_too_large", "Amount exceeds the supported invoice limit");
  return Number(value);
}

/** Computes after runtime validation. Tax applies to the rounded subtotal less the flat discount. */
export function calculateInvoice(input: unknown): CalculatedInvoice {
  const result = invoiceSchema.safeParse(input);
  if (!result.success)
    throw new InvoiceValidationError(
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    );
  const invoice = result.data;
  const precision = currencyPrecision[invoice.currency];
  const scale = 10n ** BigInt(precision);
  const amount = (value: string) => {
    const [n, d] = decimal(value);
    return round(n * scale, d);
  };
  let subtotal = 0n;
  const lines = invoice.lines.map((line, index) => {
    const [quantity, quantityScale] = decimal(line.quantity);
    const [rate, rateScale] = decimal(line.unitPrice);
    const minor = round(quantity * rate * scale, quantityScale * rateScale);
    subtotal += minor;
    return { ...line, amountMinor: safe(minor, ["lines", index, "unitPrice"]) };
  });
  const discount = amount(invoice.discount);
  if (discount > subtotal) fail(["discount"], "discount_exceeds_subtotal", "Discount must not exceed the subtotal");
  const taxable = subtotal - discount;
  const [taxRate, taxScale] = decimal(invoice.taxPercent);
  const tax = round(taxable * taxRate, taxScale * 100n);
  const total = taxable + tax;
  const paid = amount(invoice.paid);
  if (paid > total) fail(["paid"], "payment_exceeds_total", "Payment must not exceed the invoice total");
  return {
    invoice,
    lines,
    totals: {
      subtotalMinor: safe(subtotal, ["lines"]),
      discountMinor: safe(discount, ["discount"]),
      taxableMinor: safe(taxable, ["discount"]),
      taxMinor: safe(tax, ["taxPercent"]),
      totalMinor: safe(total, ["lines"]),
      paidMinor: safe(paid, ["paid"]),
      dueMinor: safe(total - paid, ["paid"]),
      precision,
    },
  };
}

/** Formats without converting minor units into a floating-point major-unit amount. */
export function formatMoney(minor: number, currency: Currency, locale: Invoice["locale"] = "en-US"): string {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new RangeError("Money must be a non-negative safe integer in minor units");
  const precision = currencyPrecision[currency];
  const scale = 10n ** BigInt(precision);
  const amount = BigInt(minor);
  const fraction = (amount % scale).toString().padStart(precision, "0");
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
    .formatToParts(amount / scale)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}
