import { fileURLToPath } from "node:url";
import { type Driver } from "@sanoma/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReplayCall, replayBridge } from "../src/bridge.ts";
import { stripeDriver } from "../src/driver.ts";
import { fakeStripe, loadReplies } from "../src/fake.ts";
import { stripe } from "../src/index.ts";

const replies = fileURLToPath(new URL("../testdata/replies/", import.meta.url));

let seq = 0;
/** Calls one of a driver's operations the way the runtime does. */
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, { idempotencyKey: `run:${++seq}`, runId: "run", opId: `stripe.${op}`, attempt: 1 });

describe("stripeDriver", () => {
  let calls: ReplayCall[];
  beforeEach(() => {
    vi.stubEnv("STRIPE_API_KEY", "rk_test_placeholder");
    calls = [];
  });

  it("configures the provider with the key, imports, then reads what the import returned", async () => {
    const bridge = replayBridge(loadReplies(replies), calls);
    const configure = vi.spyOn(bridge, "configure");
    const read = await call(stripeDriver({ bridge }), "product.read", { id: "prod_SanomaTest0001" });
    expect(calls).toEqual([
      { method: "configure" },
      { method: "import", typeName: "stripe_product", id: "prod_SanomaTest0001" },
      { method: "read", typeName: "stripe_product", id: "prod_SanomaTest0001" },
    ]);
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ source: "stripe/stripe", version: "0.3.0" }),
      JSON.stringify({ api_key: "rk_test_placeholder", stripe_account: null }),
    );
    expect(stripe.product.read.output.parse(read)).toMatchObject({
      gone: false,
      handle: "2:",
      state: { name: "Sanoma test product" },
    });
  });

  it("fails, not retryable, without STRIPE_API_KEY", async () => {
    vi.stubEnv("STRIPE_API_KEY", "");
    const bridge = replayBridge(loadReplies(replies), calls);
    const err = await call(stripeDriver({ bridge }), "product.read", { id: "prod_SanomaTest0001" }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: "stripe: STRIPE_API_KEY is not set", retryable: false });
    expect(calls).toEqual([]);
  });

  it("fails, not retryable, for an id nothing answers to", async () => {
    const bridge = replayBridge(loadReplies(replies), calls);
    const err = await call(stripeDriver({ bridge }), "webhook_endpoint.import", { id: "we_missing" }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ retryable: false, vendorCode: "not_found" });
  });
});

describe("fakeStripe", () => {
  it("returns a renamed product, as if someone renamed it in the dashboard", async () => {
    vi.stubEnv("STRIPE_API_KEY", "");
    const fake = fakeStripe();
    const before = await call(fake.driver, "product.import", { id: "prod_SanomaTest0001" });
    fake.override("product", "prod_SanomaTest0001", { name: "Renamed" });
    const after = await call(fake.driver, "product.read", before);
    expect(after.state).toEqual({ ...before.state, name: "Renamed" });
    expect(fake.calls.map((c) => c.op)).toEqual(["stripe.product.import", "stripe.product.read"]);
  });
});
