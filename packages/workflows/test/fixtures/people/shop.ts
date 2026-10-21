import { z } from "zod";
import { defineConnector } from "../../../src/index.ts";
import { defineFake } from "../../../src/fake.ts";

/** A shop that refunds, and its fake, which refunds anything. */
export const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
  },
});

export const shopFake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }) } }),
});
