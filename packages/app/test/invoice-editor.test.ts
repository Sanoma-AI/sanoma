import { commercialCleaningExample, petSittingExample, residentialCleaningExample } from "@sanoma-ai/invoices/examples";
import { calculateInvoice } from "@sanoma-ai/invoices";
import type { InvoiceFile } from "@sanoma-ai/invoices/pdf-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftErrors, draftRequest, fieldPath, initialDraft } from "../src/components/invoice-editor/draft.ts";
import { InvoicePreview, type PdfRequest, type PreviewState } from "../src/components/invoice-editor/preview.ts";

afterEach(() => vi.useRealTimers());

describe("invoice editor normalization", () => {
  it("uses shared calculations for both industries and separate billing/service addresses", () => {
    for (const [kind, input, total] of [
      ["pet-sitting", petSittingExample, 18000],
      ["cleaning", residentialCleaningExample, 24000],
      ["cleaning", commercialCleaningExample, 96000],
    ] as const) {
      const request = draftRequest(kind, initialDraft(kind, input));
      expect(calculateInvoice(request.invoice).totals.totalMinor).toBe(total);
    }
    const office = draftRequest("cleaning", initialDraft("cleaning", commercialCleaningExample));
    expect(office.invoice.recipient.address?.lines).toEqual(["20 Billing Avenue"]);
    expect(office.invoice.serviceAddress?.lines).toEqual(["30 Office Street"]);
  });

  it("keeps an empty price invalid and identifies the actual row control", () => {
    const draft = initialDraft("pet-sitting", petSittingExample);
    draft.services[1]!.unitPrice = "";
    expect(draftErrors("pet-sitting", draft)?.fields).toHaveProperty("services[1].unitPrice");
    expect(() => draftRequest("pet-sitting", draft)).toThrow("Check the invoice fields");
  });

  it("exposes aggregate amount errors on the service array", () => {
    const draft = initialDraft("cleaning", commercialCleaningExample);
    draft.currency = "KWD";
    draft.services = Array.from({ length: 100 }, (_, i) => ({
      ...draft.services[0]!,
      id: i + 1,
      quantity: "100000",
      unitPrice: "1000000",
    }));
    expect(draftErrors("cleaning", draft)?.fields.services).toBe("Amount exceeds the supported invoice limit");
  });

  it("maps nested address and period errors to labelled controls", () => {
    expect(path(["recipient", "address", "lines", 0])).toBe("recipient.street");
    expect(path(["serviceAddress", "lines", 0])).toBe("serviceAddress.street");
    expect(path(["servicePeriod", "end"])).toBe("periodEnd");
    expect(path(["lines", 2, "unitPrice"])).toBe("services[2].unitPrice");
  });
});

const path = (parts: (string | number)[]) => fieldPath({ path: parts, code: "invalid", message: "invalid" });
const request = (number: string) =>
  draftRequest("pet-sitting", initialDraft("pet-sitting", { ...petSittingExample, number }));
const file = (number: string): InvoiceFile => ({
  bytes: new Uint8Array([1]),
  filename: `invoice-${number}.pdf`,
  mediaType: "application/pdf",
  summary: calculateInvoice(request(number).invoice).totals,
});
function deferred() {
  let resolve!: (file: InvoiceFile) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<InvoiceFile>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("invoice preview revisions", () => {
  it("debounces edits and shares the pending result with download", async () => {
    vi.useFakeTimers();
    const states: PreviewState[] = [];
    const pending = deferred();
    const render = vi.fn<(request: PdfRequest) => Promise<InvoiceFile>>((_request) => pending.promise);
    const preview = new InvoicePreview((state) => states.push(state), render);
    preview.update(request("A"));
    preview.update(request("B"));
    await vi.advanceTimersByTimeAsync(300);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0]).toEqual(request("B"));
    const download = preview.obtain(request("B"));
    pending.resolve(file("B"));
    expect(await download).toBe(fileReference(states));
    expect(await preview.obtain(request("B"))).toBe(fileReference(states));
    expect(render).toHaveBeenCalledTimes(1);
    preview.close();
  });

  it("ignores stale success and failure completions", async () => {
    vi.useFakeTimers();
    const states: PreviewState[] = [];
    const a = deferred();
    const b = deferred();
    const render = vi.fn<() => Promise<InvoiceFile>>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const preview = new InvoicePreview((state) => states.push(state), render);
    preview.update(request("A"));
    await vi.advanceTimersByTimeAsync(300);
    preview.update(request("B"));
    await vi.advanceTimersByTimeAsync(300);
    b.resolve(file("B"));
    await vi.advanceTimersByTimeAsync(0);
    a.resolve(file("A"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.file?.filename).toBe("invoice-B.pdf");
    const c = deferred();
    render.mockReturnValueOnce(c.promise);
    preview.update(request("C"));
    await vi.advanceTimersByTimeAsync(300);
    preview.update(request("B"));
    c.reject(new Error("stale failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ status: "ready", file: { filename: "invoice-B.pdf" } });
    preview.close();
  });

  it("retains the previous valid PDF when new input is invalid or fails", async () => {
    vi.useFakeTimers();
    const states: PreviewState[] = [];
    const render = vi
      .fn<() => Promise<InvoiceFile>>()
      .mockResolvedValueOnce(file("A"))
      .mockRejectedValueOnce(new Error("render failed"));
    const preview = new InvoicePreview((state) => states.push(state), render);
    preview.update(request("A"));
    await vi.advanceTimersByTimeAsync(300);
    preview.update();
    expect(states.at(-1)).toMatchObject({ status: "empty", file: { filename: "invoice-A.pdf" } });
    preview.update(request("B"));
    await vi.advanceTimersByTimeAsync(300);
    expect(states.at(-1)).toMatchObject({ status: "error", file: { filename: "invoice-A.pdf" } });
    preview.close();
  });

  it("invalidates a pending completion and cancels work on unmount", async () => {
    vi.useFakeTimers();
    const states: PreviewState[] = [];
    const pending = deferred();
    const render = vi.fn<() => Promise<InvoiceFile>>(() => pending.promise);
    const preview = new InvoicePreview((state) => states.push(state), render);
    preview.update(request("A"));
    await vi.advanceTimersByTimeAsync(300);
    preview.update();
    pending.resolve(file("A"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.file).toBeUndefined();
    preview.update(request("B"));
    preview.close();
    const count = states.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toHaveLength(count);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
function fileReference(states: PreviewState[]) {
  return states.at(-1)?.file;
}
