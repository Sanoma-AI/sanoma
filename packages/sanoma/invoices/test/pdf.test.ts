import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { encode } from "fast-png";
import { InvoiceValidationError } from "sanoma/invoices";
import { renderInvoice } from "sanoma/invoices/pdf";
import { content, example } from "./helpers.ts";

describe("invoice PDF", () => {
  it("renders extractable text and exact totals", async () => {
    const file = await renderInvoice(example());
    expect(file.mediaType).toBe("application/pdf");
    expect(new TextDecoder().decode(file.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(file.summary.dueMinor).toBe(22500);
    expect(file.filename).toBe("invoice-INV-001.pdf");
    const pages = await content(file.bytes);
    expect(pages).toHaveLength(1);
    for (const text of ["Alex Morgan", "30 Office Street", "Spring refresh", "2 hours", "$225.00", "Page 1 of 1"])
      expect(pages[0]?.text).toContain(text);
    expect(pages[0]?.width).toBeCloseTo(595.28, 1);
  });
  it("wraps many service lines, repeats headings and retains final totals and notes", async () => {
    const invoice = example();
    invoice.lines = Array.from({ length: 40 }, (_, i) => ({
      description: `Service ${i + 1}: ${"Detailed review of the plans, the budget and the schedule. ".repeat(6)}`,
      unit: "visit",
      quantity: "1",
      unitPrice: "120",
      serviceDate: "2026-10-20",
    }));
    invoice.notes = "Final payment reference: INV-001";
    invoice.presentation = { paper: "LETTER" };
    const file = await renderInvoice(invoice);
    const pages = await content(file.bytes);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.text.includes("Quantity") && page.text.includes("Example Studio"))).toBe(true);
    expect(pages.map((page) => page.text).join(" ")).toContain("Service 40:");
    expect(pages.at(-1)?.text).toContain("$4,800.00");
    expect(pages.at(-1)?.text).toContain(invoice.notes);
    expect(pages.every((page) => page.width === 612 && page.height === 792)).toBe(true);
  });
  it("renders a validated PNG logo and rejects corruption and URL inputs", async () => {
    const image = encode({ width: 2, height: 2, data: new Uint8Array(16).fill(160), channels: 4, depth: 8 });
    const logo = { mediaType: "image/png" as const, base64: Buffer.from(image).toString("base64") };
    const invoice = example();
    expect((await content((await renderInvoice(invoice, { logo })).bytes))[0]?.text).toContain("Spring refresh");
    image[image.length - 1] = image[image.length - 1]! ^ 1;
    await expect(
      renderInvoice(invoice, { logo: { ...logo, base64: Buffer.from(image).toString("base64") } }),
    ).rejects.toBeInstanceOf(InvoiceValidationError);
    await expect(
      renderInvoice(invoice, { logo: { ...logo, base64: "https://example.com/logo.png" } }),
    ).rejects.toBeInstanceOf(InvoiceValidationError);
  });
  it("rejects unsupported glyphs and excess rows explicitly", async () => {
    const invoice = example();
    await expect(renderInvoice({ ...invoice, notes: "🐈" })).rejects.toMatchObject({
      code: "invalid_invoice",
      issues: [{ code: "unsupported_text", path: ["notes"] }],
    });
    await expect(
      renderInvoice({ ...invoice, lines: Array.from({ length: 101 }, () => invoice.lines[0]!) }),
    ).rejects.toMatchObject({ code: "invalid_invoice", issues: [{ code: "too_many_lines", path: ["lines"] }] });
  });
  it("renders accented names and sanitizes a caller-supplied filename", async () => {
    const invoice = example();
    invoice.recipient.name = "Françoise Müller";
    invoice.number = "../../Invoice #1";
    const file = await renderInvoice(invoice);
    expect(file.filename).toBe("invoice-Invoice-1.pdf");
    expect((await content(file.bytes))[0]?.text).toContain("Françoise Müller");
  });
  it("reports descriptions too tall for a row and newlines in single-line fields", async () => {
    const invoice = example();
    await expect(renderInvoice({ ...invoice, number: "ONE\nTWO" })).rejects.toMatchObject({
      issues: [{ code: "multiline_field", path: ["number"] }],
    });
    await expect(
      renderInvoice({ ...invoice, lines: [{ ...invoice.lines[0]!, description: "Work\n".repeat(60) }] }),
    ).rejects.toMatchObject({ issues: [{ code: "description_too_long", path: ["lines", 0, "description"] }] });
  });
  it("keeps long unbroken descriptions and large amounts extractable", async () => {
    const invoice = example();
    invoice.lines = [{ description: "W".repeat(600), quantity: "99999", unit: "job", unitPrice: "900719925" }];
    const pages = await content((await renderInvoice(invoice)).bytes);
    const text = pages.map((page) => page.text).join(" ");
    expect(text.replace(/[^W]/g, "").length).toBe(600);
    expect(text).toContain("$90,071,091,780,075.00");
  });
  it("renders French currency spacing using supported font glyphs", async () => {
    const invoice = example();
    invoice.currency = "EUR";
    invoice.locale = "fr-FR";
    invoice.lines = [{ description: "Conseil", quantity: "1", unit: "job", unitPrice: "1234.5678" }];
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
      renderInvoice(example(), {
        logo: { mediaType: "image/png", base64: bytes.toString("base64") },
      }),
    ).rejects.toMatchObject({ issues: [{ code: "invalid_logo", path: ["logo"] }] });
  });
});

/** `sanoma/invoices/pdf` loaded afresh over `renderer`, what its `import("@react-pdf/renderer")` gives at a render. */
async function over(renderer: () => object) {
  vi.resetModules();
  vi.doMock("@react-pdf/renderer", renderer);
  return (await import("sanoma/invoices/pdf")).renderInvoice;
}

describe("the renderer", () => {
  afterEach(() => {
    vi.doUnmock("@react-pdf/renderer");
    vi.resetModules();
  });

  it("says what to install when the company has no renderer, after validating the input", async () => {
    // Node itself, as the worker loads the source, with `@react-pdf/renderer` resolving to no package.
    const script = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve: (specifier, context, next) =>
        next(specifier === "@react-pdf/renderer" ? "@react-pdf/renderer-absent" : specifier, context) });
      const { renderInvoice } = await import("sanoma/invoices/pdf");
      const failure = (input) => renderInvoice(input).then(() => "rendered", (error) => error.code ?? error.message);
      console.log(JSON.stringify([await failure({}), await failure(${JSON.stringify(example())})]));`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--conditions=sanoma-source", "--input-type=module", "--eval", script],
      { cwd: fileURLToPath(new URL(".", import.meta.url)) },
    );
    const [invalid, missing] = JSON.parse(stdout) as string[];
    expect(invalid).toBe("invalid_invoice");
    expect(missing).toMatch(/needs @react-pdf\/renderer: install it beside sanoma/);
  });

  it("reports a renderer's failure as render_failed, without its details", async () => {
    const render = await over(async () => ({
      ...(await vi.importActual<object>("@react-pdf/renderer")),
      pdf: () => ({ toBlob: () => Promise.reject(new Error("private customer data")) }),
    }));
    const failure = render(example());
    await expect(failure).rejects.toMatchObject({ name: "InvoiceRenderError", code: "render_failed" });
    await expect(failure).rejects.not.toThrow(/private/);
  });
});
