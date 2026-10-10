import { loadReplies, stateBridge } from "@sanoma/bridge/fake";
import { type Driver } from "@sanoma/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripeDriver } from "../src/driver.ts";
import { fakeStripe } from "../src/fake.ts";
import { stripe } from "../src/index.ts";
import { provider } from "../src/resources.gen.ts";

const fixtures = new URL("../testdata/", import.meta.url);

let seq = 0;
/** Calls one of a driver's operations the way the runtime does. */
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, { idempotencyKey: `run:${++seq}`, runId: "run", opId: `stripe.${op}`, attempt: 1 });

describe("stripeDriver", () => {
  let bridge: ReturnType<typeof stateBridge>;
  const calls = () => bridge.calls.map(({ method, typeName, id }) => [method, typeName, id]);
  beforeEach(() => {
    vi.stubEnv("STRIPE_API_KEY", "rk_test_placeholder");
    bridge = stateBridge(loadReplies(fixtures, provider));
  });

  it("configures the provider with the key, and imports a product, which reads it too", async () => {
    const configure = vi.spyOn(bridge, "configure");
    const read = await call(stripeDriver({ bridge }), "product.read", { id: "prod_SanomaTest0001" });
    expect(calls()).toEqual([
      ["configure", undefined, undefined],
      ["import", "stripe_product", "prod_SanomaTest0001"],
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
    const err = await call(stripeDriver({ bridge }), "product.read", { id: "prod_SanomaTest0001" }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: "stripe: STRIPE_API_KEY is not set", retryable: false });
    expect(calls()).toEqual([]);
  });

  it("answers gone for an id nothing answers to", async () => {
    expect(await call(stripeDriver({ bridge }), "webhook_endpoint.import", { id: "we_missing" })).toEqual({
      id: "we_missing",
      gone: true,
    });
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

  it("never returns a webhook endpoint's secret", async () => {
    const fake = fakeStripe();
    fake.override("webhook_endpoint", "we_SanomaTest0001", { secret: "whsec_not_a_real_one" });
    const read = await call(fake.driver, "webhook_endpoint.read", { id: "we_SanomaTest0001" });
    expect(read.state).toMatchObject({ url: "https://example.com/sanoma/stripe-webhook", secret: null });
  });
});
