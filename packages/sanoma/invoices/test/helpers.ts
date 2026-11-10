import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { InvoiceInput } from "sanoma/invoices";
import { expect } from "vitest";

/** A fictional invoice the tests share: $225.00 due, with a service address apart from the billing one. */
export const example = (): InvoiceInput => ({
  number: "INV-001",
  issuedOn: "2026-10-30",
  dueOn: "2026-11-13",
  currency: "USD",
  issuer: { name: "Example Studio", email: "hello@example.com" },
  recipient: { name: "Alex Morgan", address: { lines: ["20 Billing Avenue"], city: "Portland" } },
  serviceAddress: { lines: ["30 Office Street"], city: "Portland" },
  details: [{ label: "Project", value: "Spring refresh" }],
  lines: [
    { description: "Consultation", unit: "hour", quantity: "2", unitPrice: "90" },
    { description: "Site visit", unit: "visit", quantity: "1", unitPrice: "45" },
  ],
});

/** Each page's text and size, failing on any text drawn into the margins. */
export async function content(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 });
  const document = await task.promise;
  try {
    const pages = [];
    const clipped: string[] = [];
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const text = await page.getTextContent();
      for (const item of text.items) {
        if (
          "str" in item &&
          item.str.trim() &&
          (item.transform[4] < 30 ||
            item.transform[4] + item.width > page.view[2]! - 30 ||
            item.transform[5] < 18 ||
            item.transform[5] + item.height > page.view[3]! - 20)
        )
          clipped.push(item.str);
      }
      pages.push({
        text: text.items.flatMap((item) => ("str" in item ? [item.str] : [])).join(" "),
        width: page.view[2],
        height: page.view[3],
      });
    }
    expect(clipped).toEqual([]);
    return pages;
  } finally {
    await task.destroy();
  }
}
