import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, defineWorkflow } from "../src/index.ts";

// These assertions are checked by `pnpm typecheck`; the runtime test only keeps vitest happy.
const shop = defineConnector("shop", {
  order: {
    get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ total: z.number() }) },
    refund: { effect: "money", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
});

export const wf = defineWorkflow({
  name: "refund-check",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [shop.order.get, "sleep"],
  run: async (ctx, { id }) => {
    const order = await ctx.shop.order.get({ id });
    const total: number = order.total;
    await ctx.sleep({ minutes: 5 });
    // @ts-expect-error refund is not in `uses`
    await ctx.shop.order.refund({ id });
    // @ts-expect-error approval is not in `uses`
    await ctx.approval("x", { approver: "y" });
    // @ts-expect-error input is checked against the operation's schema
    await ctx.shop.order.get({ id: 1 });
    return total;
  },
});

describe("types", () => {
  it("builds operation ids from vendor, resource and name", () => {
    expect(shop.order.refund.id).toBe("shop.order.refund");
    expect(shop.order.refund.effect).toBe("money");
  });

  it("rejects workflow names that are not lowercase slugs", () => {
    expect(() =>
      defineWorkflow({ name: "Bad Name", trigger: "manual", input: z.object({}), uses: [], run: async () => {} }),
    ).toThrow(/lowercase/);
  });
});
