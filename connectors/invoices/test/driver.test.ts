import { randomUUID } from "node:crypto";
import { petSittingInvoice } from "@sanoma-ai/invoices";
import { commercialCleaningExample, petSittingExample, residentialCleaningExample } from "@sanoma-ai/invoices/examples";
import * as renderer from "@sanoma-ai/invoices/node";
import { memorySecrets, resolveConfig } from "@sanoma-ai/workflows";
import { describe, expect, it, vi } from "vitest";
import { fileSchema, workflowPdfLimits, type GenerateInput, type PdfFile } from "../src/connector.ts";
import { invoicesDriver } from "../src/driver.ts";
import { fakeInvoices } from "../src/fake.ts";
import { invoices } from "../src/index.ts";

const context = () => ({
  idempotencyKey: randomUUID(),
  runId: "invoice-test",
  opId: invoices.pdf.generate.id,
  attempt: 1,
  secrets: memorySecrets(),
});
const cases: [string, GenerateInput, number][] = [
  ["standard", { document: { kind: "invoice", invoice: petSittingInvoice(petSittingExample) } }, 18000],
  ["pet sitting", { document: { kind: "pet-sitting", invoice: petSittingExample } }, 18000],
  ["residential cleaning", { document: { kind: "cleaning", invoice: residentialCleaningExample } }, 24000],
  ["commercial cleaning", { document: { kind: "cleaning", invoice: commercialCleaningExample } }, 96000],
];

describe("invoice driver", () => {
  it.each(cases)("generates a real JSON-safe PDF for %s", async (_, input, total) => {
    const file = fileSchema.parse(await invoicesDriver().ops["pdf.generate"]!(input, context()));
    expect(file.summary.totalMinor).toBe(total);
    const bytes = Buffer.from(file.base64, "base64");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.byteLength).toBe(file.byteLength);
    expect(fileSchema.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThan(workflowPdfLimits.jsonBytes);
  });

  it("declares a read, target and credential-free setup", () => {
    expect(invoices.pdf.generate).toMatchObject({ effect: "read", idempotent: true, opaque: ["base64", "options"] });
    expect(invoices.pdf.generate.target!({ document: { invoice: { number: "ACME/01" } } })).toBe("invoice/ACME%2F01");
    const config = resolveConfig({ workflows: [], connectors: [invoices] });
    expect(config.driversByVendor.get("invoices")?.env).toBeUndefined();
    expect(config.fakes.has("invoices")).toBe(true);
  });

  it("uses real generation in scenarios and reuses an idempotency key", async () => {
    const fake = fakeInvoices();
    const call = context();
    const input = { document: { kind: "pet-sitting", invoice: petSittingExample } } as const;
    const output = (await fake.driver.ops["pdf.generate"]!(input, call)) as PdfFile;
    expect(Buffer.from(output.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.summary.totalMinor).toBe(18000);
    expect(await fake.driver.ops["pdf.generate"]!(input, call)).toEqual(output);
  });

  it.each([
    { ...petSittingExample, services: [{ service: "visit", quantity: "0", unitPrice: "10" }] },
    { ...petSittingExample, paid: "181" },
    { ...petSittingExample, dueOn: "2026-10-29" },
    { ...petSittingExample, issuer: { name: "Unsupported 🐾" } },
  ])("refuses invalid inputs without retries", async (invoice) => {
    for (const driver of [invoicesDriver(), fakeInvoices().driver]) {
      await expect(
        driver.ops["pdf.generate"]!({ document: { kind: "pet-sitting", invoice } }, context()),
      ).rejects.toMatchObject({
        retryable: false,
        vendorCode: "invalid_invoice",
        status: 422,
      });
    }
  });

  it("rejects malformed assets without fetching their value", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      invoicesDriver().ops["pdf.generate"]!(
        {
          document: { kind: "pet-sitting", invoice: petSittingExample },
          options: { logo: { mediaType: "image/png", base64: "https://example.invalid/logo.png" } },
        },
        context(),
      ),
    ).rejects.toMatchObject({ retryable: false, vendorCode: "invalid_invoice" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds encoded checkpoint size and checks byte lengths", async () => {
    const original = await renderer.renderInvoice(petSittingInvoice(petSittingExample));
    const render = vi.spyOn(renderer, "renderInvoice");
    render.mockResolvedValue({ ...original, bytes: new Uint8Array(workflowPdfLimits.bytes) });
    const boundary = fileSchema.parse(
      await invoicesDriver().ops["pdf.generate"]!(
        { document: { kind: "pet-sitting", invoice: petSittingExample } },
        context(),
      ),
    );
    expect(boundary.byteLength).toBe(workflowPdfLimits.bytes);
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBeLessThan(workflowPdfLimits.jsonBytes);
    render.mockResolvedValue({
      ...original,
      bytes: new Uint8Array(workflowPdfLimits.bytes + 1),
    });
    await expect(
      invoicesDriver().ops["pdf.generate"]!(
        { document: { kind: "pet-sitting", invoice: petSittingExample } },
        context(),
      ),
    ).rejects.toMatchObject({ retryable: false, vendorCode: "output_too_large" });
    const { bytes: _bytes, ...metadata } = original;
    expect(fileSchema.safeParse({ ...metadata, currency: "USD", base64: "JVBERg==", byteLength: 5 }).success).toBe(
      false,
    );
  });

  it("reports renderer failures without retrying or leaking their details", async () => {
    vi.spyOn(renderer, "renderInvoice").mockRejectedValue(new Error("private customer data"));
    await expect(
      invoicesDriver().ops["pdf.generate"]!(
        { document: { kind: "pet-sitting", invoice: petSittingExample } },
        context(),
      ),
    ).rejects.toMatchObject({
      retryable: false,
      vendorCode: "render_failed",
      message: "Invoice PDF generation failed; check the invoice size and content",
    });
  });
});
