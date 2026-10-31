import { withSetup } from "@sanoma-ai/workflows";
import { invoicesOps } from "./connector.ts";
import { invoicesDriver } from "./driver.ts";
import { fakeInvoices } from "./fake.ts";
import { invoicesSteps } from "./steps.ts";

export const invoices = withSetup(invoicesOps, { driver: invoicesDriver, fake: fakeInvoices, steps: invoicesSteps });
export type { GenerateInput, PdfFile } from "./connector.ts";
