import { defineDriver } from "@sanoma-ai/workflows";
import { invoicesOps } from "./connector.ts";
import { generate } from "./generate.ts";

/** Local computation: no account, credentials, network, or external side effects. */
export function invoicesDriver() {
  return defineDriver(invoicesOps, { pdf: { generate } });
}
