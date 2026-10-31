import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { invoicesOps } from "./connector.ts";
import { generate } from "./generate.ts";

/** Runs the real pure generator in scenarios, with the usual call log and fault injection. */
export function fakeInvoices(options: FakeOptions = {}) {
  return defineFake(invoicesOps, { initial: () => ({}), ops: () => ({ pdf: { generate } }) }, options);
}
