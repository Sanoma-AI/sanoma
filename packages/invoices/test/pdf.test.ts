import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { encode } from "fast-png";
import { renderInvoice } from "../src/node.ts";
import { cleaningInvoice, petSittingInvoice, InvoiceValidationError } from "../src/index.ts";
import { petSittingExample, residentialCleaningExample, commercialCleaningExample } from "../src/examples.ts";

async function content(bytes: Uint8Array) {
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

describe("Node invoice PDF", () => {
  it.each([
    ["pet sitting", petSittingInvoice(petSittingExample), 18000, "Milo, Luna"],
    ["residential cleaning", cleaningInvoice(residentialCleaningExample), 24000, "Two-bedroom home"],
    ["commercial cleaning", cleaningInvoice(commercialCleaningExample), 96000, "30 Office Street"],
  ] as const)("renders %s with extractable text and exact totals", async (_, invoice, total, detail) => {
    const file = await renderInvoice(invoice);
    expect(file.mediaType).toBe("application/pdf");
    expect(new TextDecoder().decode(file.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(file.summary.dueMinor).toBe(total);
    expect(file.filename).toMatch(/^invoice-[\w-]+\.pdf$/);
    const pages = await content(file.bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain(detail);
    expect(pages[0]?.text).toContain(invoice.recipient.name);
    expect(pages[0]?.text).toContain(`$${total / 100}.00`);
    expect(pages[0]?.text).toContain("Page 1 of 1");
    expect(pages[0]?.width).toBeCloseTo(595.28, 1);
  });
  it("wraps many service lines, repeats headings and retains final totals and notes", async () => {
    const invoice = cleaningInvoice(commercialCleaningExample);
    invoice.lines = Array.from({ length: 40 }, (_, i) => ({
      description: `Service ${i + 1}: ${"Detailed cleaning of work areas and meeting rooms. ".repeat(6)}`,
      unit: "visit",
      quantity: "1",
      unitPrice: "120",
      serviceDate: "2026-10-20",
    }));
    invoice.notes = "Final payment reference: OFFICE-001";
    invoice.presentation.paper = "LETTER";
    const file = await renderInvoice(invoice);
    const pages = await content(file.bytes);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.text.includes("Quantity") && page.text.includes("Clover Cleaning"))).toBe(true);
    expect(pages.map((page) => page.text).join(" ")).toContain("Service 40:");
    expect(pages.at(-1)?.text).toContain("$4,800.00");
    expect(pages.at(-1)?.text).toContain(invoice.notes);
    expect(pages.every((page) => page.width === 612 && page.height === 792)).toBe(true);
  });
  it("renders a validated PNG logo and rejects corruption and URL inputs", async () => {
    const image = encode({ width: 2, height: 2, data: new Uint8Array(16).fill(160), channels: 4, depth: 8 });
    const logo = { mediaType: "image/png" as const, base64: Buffer.from(image).toString("base64") };
    const invoice = petSittingInvoice(petSittingExample);
    expect((await content((await renderInvoice(invoice, { logo })).bytes))[0]?.text).toContain("Milo, Luna");
    image[image.length - 1] = image[image.length - 1]! ^ 1;
    await expect(
      renderInvoice(invoice, { logo: { ...logo, base64: Buffer.from(image).toString("base64") } }),
    ).rejects.toBeInstanceOf(InvoiceValidationError);
    await expect(
      renderInvoice(invoice, { logo: { ...logo, base64: "https://example.com/logo.png" } }),
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });
  it("rejects unsupported glyphs and excess rows explicitly", async () => {
    const invoice = petSittingInvoice(petSittingExample);
    await expect(renderInvoice({ ...invoice, notes: "🐈" })).rejects.toMatchObject({
      code: "invalid_invoice",
      issues: [{ code: "unsupported_text", path: ["notes"] }],
    });
    await expect(
      renderInvoice({ ...invoice, lines: Array.from({ length: 101 }, () => invoice.lines[0]!) }),
    ).rejects.toMatchObject({ code: "invalid_invoice", issues: [{ code: "too_many_lines", path: ["lines"] }] });
  });
  it("renders accented names and sanitizes a caller-supplied filename", async () => {
    const invoice = cleaningInvoice(residentialCleaningExample);
    invoice.recipient.name = "Françoise Müller";
    invoice.number = "../../Invoice #1";
    const file = await renderInvoice(invoice);
    expect(file.filename).toBe("invoice-Invoice-1.pdf");
    expect((await content(file.bytes))[0]?.text).toContain("Françoise Müller");
  });
  it("reports descriptions too tall for a row and newlines in single-line fields", async () => {
    const invoice = cleaningInvoice(residentialCleaningExample);
    await expect(renderInvoice({ ...invoice, number: "ONE\nTWO" })).rejects.toMatchObject({
      issues: [{ code: "multiline_field", path: ["number"] }],
    });
    await expect(
      renderInvoice({ ...invoice, lines: [{ ...invoice.lines[0]!, description: "Work\n".repeat(60) }] }),
    ).rejects.toMatchObject({ issues: [{ code: "description_too_long", path: ["lines", 0, "description"] }] });
  });
  it("keeps long unbroken descriptions and large amounts extractable", async () => {
    const invoice = cleaningInvoice(residentialCleaningExample);
    invoice.lines = [{ description: "W".repeat(600), quantity: "99999", unit: "job", unitPrice: "900719925" }];
    const pages = await content((await renderInvoice(invoice)).bytes);
    const text = pages.map((page) => page.text).join(" ");
    expect(text.replace(/[^W]/g, "").length).toBe(600);
    expect(text).toContain("$90,071,091,780,075.00");
  });
  it("renders French currency spacing using supported font glyphs", async () => {
    const invoice = cleaningInvoice(residentialCleaningExample);
    invoice.currency = "EUR";
    invoice.locale = "fr-FR";
    invoice.lines = [{ description: "Nettoyage", quantity: "1", unit: "job", unitPrice: "1234.5678" }];
    const text = (await content((await renderInvoice(invoice)).bytes))
      .map((page) => page.text)
      .join(" ")
      .replace(/\s/g, "");
    expect(text).toContain("1234,57€");
    expect(text).toContain("1234,5678€");
  });
  it("rejects color-key PNG transparency instead of silently removing it", async () => {
    const rgb = encode({ width: 2, height: 2, data: new Uint8Array(12), channels: 3, depth: 8 });
    const transparency = Buffer.alloc(18);
    transparency.writeUInt32BE(6, 0);
    transparency.write("tRNS", 4);
    transparency.writeUInt32BE(crc32(transparency.subarray(4, 14)), 14);
    const bytes = Buffer.concat([rgb.subarray(0, 33), transparency, rgb.subarray(33)]);
    await expect(
      renderInvoice(petSittingInvoice(petSittingExample), {
        logo: { mediaType: "image/png", base64: bytes.toString("base64") },
      }),
    ).rejects.toMatchObject({ issues: [{ code: "invalid_logo", path: ["logo"] }] });
  });
});
