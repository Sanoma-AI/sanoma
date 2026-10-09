import { readFileSync } from "node:fs";
import { fromTfState } from "@sanoma/bridge/tfschema";
import { describe, expect, it } from "vitest";
import { stripeTf } from "../src/connector.ts";
import { stripe } from "../src/index.ts";
import { stripe as declare } from "../src/resources.ts";

const replies = new URL("../testdata/replies/stripe_stripe_0.3.0/", import.meta.url);
const TYPES = stripeTf.types;

/** The state a read in `testdata/replies` returned, as the provider holds it. */
const replied = (path: string) => {
  const { response } = JSON.parse(readFileSync(new URL(path, replies), "utf8"));
  return JSON.parse(response.resource.stateJson) as Record<string, unknown>;
};

describe("the generated Stripe resource types", () => {
  it("parse a product's read", () => {
    const state = fromTfState(TYPES.product.shape, replied("stripe_product/prod_SanomaTest0001/read.json"));
    expect(TYPES.product.schema.parse(state)).toMatchObject({
      id: "prod_SanomaTest0001",
      name: "Sanoma test product",
      metadata: { owner: "sanoma" },
      default_price_data: [],
    });
  });

  it("parse a webhook endpoint's read, without its secret", () => {
    const tf = replied("stripe_webhook_endpoint/we_SanomaTest0001/read.json");
    const state = fromTfState(TYPES.webhook_endpoint.shape, { ...tf, secret: "<scrubbed>" });
    expect(TYPES.webhook_endpoint.schema.parse(state)).toMatchObject({
      url: "https://example.com/sanoma/stripe-webhook",
      enabled_events: ["product.updated"],
      secret: null,
    });
  });

  it("flag the webhook's secret write-only and what Stripe sets vendor-owned", () => {
    expect(TYPES.webhook_endpoint.fields.writeOnly).toEqual(["secret"]);
    expect(TYPES.product.fields.vendorOwned).toEqual([
      "created",
      "default_price",
      "id",
      "livemode",
      "object",
      "updated",
    ]);
    expect(TYPES.webhook_endpoint.fields.immutable).toEqual(["api_version", "connect"]);
  });
});

describe("the stripe connector", () => {
  it.each(["product", "webhook_endpoint"] as const)("reads and imports %s, effect read, by its id", (type) => {
    for (const op of [stripe[type].read, stripe[type].import]) {
      expect(op).toMatchObject({ vendor: "stripe", resource: type, effect: "read", idempotent: true });
    }
    expect(declare[type].identity).toBe("id");
  });

  it("declares resources by Stripe's id, which a data file must give", () => {
    expect(declare.product({ id: "prod_SanomaTest0001", name: "Pro" }).name).toBe("prod_SanomaTest0001");
    expect(() => declare.product({ name: "Pro" })).toThrow("stripe.product: its id is missing");
    // Stripe sets `created`; only the id, which the identity names, may be declared of what it owns.
    expect(() => declare.product({ id: "prod_SanomaTest0001", name: "Pro", created: 1 })).toThrow(
      "stripe.product: leave out created: the vendor sets it",
    );
  });
});
