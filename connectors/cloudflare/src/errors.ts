import { DriverError } from "@sanoma-ai/workflows";

/** The driver's own refusal, before or instead of a call: never retried. */
export const refused = (message: string, vendorCode?: string) =>
  new DriverError(`cloudflare: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });
