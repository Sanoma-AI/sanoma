import type { InvoiceInput } from "@sanoma-ai/invoices";
import type { InvoiceFile, PdfOptions } from "@sanoma-ai/invoices/pdf-contract";

export interface PdfRequest {
  invoice: InvoiceInput;
  options: PdfOptions;
}
export type PdfRenderer = (request: PdfRequest) => Promise<InvoiceFile>;
export type PreviewState = {
  status: "empty" | "updating" | "ready" | "error";
  file?: InvoiceFile;
  error?: unknown;
  key?: string;
};
export const requestKey = (request: PdfRequest) => JSON.stringify(request);
const browserRender: PdfRenderer = async ({ invoice, options }) =>
  (await import("@sanoma-ai/invoices/browser")).renderInvoice(invoice, options);

/** One in-memory render path for preview and download, with revision checks around every completion. */
export class InvoicePreview {
  private key?: string;
  private state: PreviewState = { status: "empty" };
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, Promise<InvoiceFile>>();
  private closed = false;
  private changed: (state: PreviewState) => void;
  private render: PdfRenderer;
  private delay: number;
  constructor(changed: (state: PreviewState) => void, render: PdfRenderer = browserRender, delay = 300) {
    this.changed = changed;
    this.render = render;
    this.delay = delay;
  }

  update(request?: PdfRequest) {
    clearTimeout(this.timer);
    this.key = request && requestKey(request);
    if (!request) {
      this.publish({ ...this.state, status: "empty", error: undefined });
      return;
    }
    if (this.state.key === this.key && this.state.file) {
      this.publish({ ...this.state, status: "ready", error: undefined });
      return;
    }
    this.publish({ ...this.state, status: "updating", error: undefined });
    this.timer = setTimeout(() => {
      void this.obtain(request).catch(() => undefined);
    }, this.delay);
  }

  /** Validated current data goes here too; a mismatched older preview is never returned. */
  obtain(request: PdfRequest): Promise<InvoiceFile> {
    if (this.closed) return Promise.reject(new Error("The editor is closed"));
    const key = requestKey(request);
    if (key === this.state.key && this.state.file) return Promise.resolve(this.state.file);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.render(request)
      .then(
        (file) => {
          if (!this.closed && key === this.key) this.publish({ status: "ready", file, key });
          return file;
        },
        (error: unknown) => {
          if (!this.closed && key === this.key) this.publish({ ...this.state, status: "error", error });
          throw error;
        },
      )
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, result);
    return result;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }
  private publish(state: PreviewState) {
    this.state = state;
    if (!this.closed) this.changed(state);
  }
}
