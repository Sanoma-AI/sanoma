import { describe, expect, it } from "vitest";
import { calculateInvoice, formatMoney, InvoiceValidationError, type InvoiceInput } from "sanoma/invoices";
import { example } from "./helpers.ts";

const invoice = (overrides: Partial<InvoiceInput> = {}): InvoiceInput => ({
  number: "INV-1",
  issuedOn: "2026-10-30",
  currency: "USD",
  issuer: { name: "A Business" },
  recipient: { name: "A Customer" },
  lines: [{ description: "Work", unit: "hour", quantity: "1", unitPrice: "100" }],
  ...overrides,
});
function validationFailure(action: () => unknown) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(InvoiceValidationError);
  return (failure as InvoiceValidationError).issues;
}
const issues = (input: unknown) => validationFailure(() => calculateInvoice(input));

describe("the invoice's shape", () => {
  it("keeps the billing and service addresses apart, applies defaults and leaves the input as it was", () => {
    const input = example();
    const before = JSON.stringify(input);
    const result = calculateInvoice(input);
    expect(result.totals.dueMinor).toBe(22500);
    expect(result.invoice.recipient.address?.lines).toEqual(["20 Billing Avenue"]);
    expect(result.invoice.serviceAddress?.lines).toEqual(["30 Office Street"]);
    expect(result.invoice).toMatchObject({ schemaVersion: 1, locale: "en-US", taxPercent: "0" });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("exact invoice arithmetic", () => {
  it("rounds each line half up before summing and taxes the discounted subtotal", () => {
    const result = calculateInvoice(
      invoice({
        lines: [
          { description: "Fractional hours", unit: "hour", quantity: "1.5", unitPrice: "10.01" },
          { description: "Small adjustment", unit: "charge", quantity: "1", unitPrice: "0.005" },
        ],
        discount: "1.02",
        taxPercent: "8.25",
        paid: "10",
      }),
    );
    expect(result.lines.map((line) => line.amountMinor)).toEqual([1502, 1]);
    expect(result.totals).toEqual({
      subtotalMinor: 1503,
      discountMinor: 102,
      taxableMinor: 1401,
      taxMinor: 116,
      totalMinor: 1517,
      paidMinor: 1000,
      dueMinor: 517,
      precision: 2,
    });
  });
  it.each([
    ["USD", "0.005", 1],
    ["JPY", "0.5", 1],
    ["KWD", "0.0005", 1],
  ] as const)("uses %s currency precision", (currency, unitPrice, expected) => {
    expect(
      calculateInvoice(
        invoice({ currency, lines: [{ description: "Service", unit: "job", quantity: "1", unitPrice }] }),
      ).totals.totalMinor,
    ).toBe(expected);
  });
  it("permits zero-priced work and fully paid invoices", () => {
    expect(calculateInvoice(invoice({ paid: "100" })).totals.dueMinor).toBe(0);
    expect(
      calculateInvoice(
        invoice({ lines: [{ description: "Complimentary", unit: "job", quantity: "1", unitPrice: "0" }] }),
      ).totals.totalMinor,
    ).toBe(0);
  });
  it("formats exact large amounts without floating point loss", () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, "USD")).toBe("$90,071,992,547,409.91");
    expect(formatMoney(12345, "EUR", "de-DE")).toBe("123,45 €");
    expect(formatMoney(12345, "KWD")).toBe("KWD 12.345");
  });
});

describe("invalid input", () => {
  it.each(["", "-1", "1e2", "NaN", "Infinity", "1,000", "0.00001"])("rejects ambiguous price %s", (unitPrice) => {
    expect(
      issues(invoice({ lines: [{ description: "Work", unit: "job", quantity: "1", unitPrice }] }))[0]?.path,
    ).toEqual(["lines", 0, "unitPrice"]);
  });
  it("rejects missing, numeric, zero-quantity and unknown fields", () => {
    expect(issues({})).not.toHaveLength(0);
    expect(
      issues(invoice({ lines: [{ description: "Work", unit: "job", quantity: "0", unitPrice: "1" }] }))[0]?.path,
    ).toEqual(["lines", 0, "quantity"]);
    expect(issues({ ...invoice(), paid: 1 })[0]?.path).toEqual(["paid"]);
    expect(issues({ ...invoice(), html: "<script>" })[0]?.code).toBe("unrecognized_keys");
  });
  it("rejects impossible dates and reversed date ranges", () => {
    expect(issues(invoice({ issuedOn: "2026-02-30" }))[0]?.path).toEqual(["issuedOn"]);
    expect(issues(invoice({ dueOn: "2026-10-29" }))[0]?.path).toEqual(["dueOn"]);
    expect(issues(invoice({ servicePeriod: { start: "2026-10-30", end: "2026-10-01" } }))[0]?.path).toEqual([
      "servicePeriod",
      "end",
    ]);
  });
  it("rejects excessive discount, payment, precision, tax and totals", () => {
    expect(issues(invoice({ discount: "101" }))[0]?.code).toBe("discount_exceeds_subtotal");
    expect(issues(invoice({ paid: "101" }))[0]?.code).toBe("payment_exceeds_total");
    expect(issues(invoice({ paid: "0.001" }))[0]?.path).toEqual(["paid"]);
    expect(issues(invoice({ taxPercent: "100.0001" }))[0]?.path).toEqual(["taxPercent"]);
    expect(
      issues(invoice({ lines: [{ description: "Large", unit: "job", quantity: "999999", unitPrice: "999999999" }] }))[0]
        ?.code,
    ).toBe("amount_too_large");
  });
  it("does not include submitted values in serialized errors", () => {
    expect(
      JSON.stringify(issues({ ...invoice(), issuer: { name: "", email: "private-invalid-email" } })),
    ).not.toContain("private-invalid-email");
  });
});
