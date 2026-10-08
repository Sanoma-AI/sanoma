import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConnector, defineDriver, defineWorkflow, type SanomaClient } from "../src/index.ts";

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

export const fan = defineWorkflow({
  name: "fan",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [shop.order.get, "all"],
  run: async (ctx, { id }) => {
    // Each output keeps its member's type, in order.
    const [order, label] = await ctx.all([() => ctx.shop.order.get({ id }), async () => "x" as const]);
    const total: number = order.total;
    const x: "x" = label;
    // @ts-expect-error a member is a function, not a promise
    await ctx.all([ctx.shop.order.get({ id })]);
    const none: [] = await ctx.all([]);
    return [total, x, none];
  },
});

export const noAll = defineWorkflow({
  name: "no-all",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async (ctx) => {
    // @ts-expect-error all is not in `uses`
    await ctx.all([]);
  },
});

export const shopDriver = defineDriver(shop, {
  order: {
    get: async ({ id }, call) => ({ total: id.length + call.attempt }),
    refund: async () => ({ ok: true }),
  },
});

const wrongInput = () =>
  defineDriver(shop, {
    order: {
      // @ts-expect-error the input is the connector's: `id` is a string
      get: async (input: { id: number }) => ({ total: input.id }),
      refund: async () => ({ ok: true }),
    },
  });

const wrongOutput = () =>
  defineDriver(shop, {
    order: {
      // @ts-expect-error the output is the connector's: `total` is a number
      get: async () => ({ total: "12" }),
      refund: async () => ({ ok: true }),
    },
  });

const incomplete = () =>
  defineDriver(shop, {
    // @ts-expect-error a driver implements every operation: refund is missing
    order: { get: async () => ({ total: 1 }) },
  });

const undeclared = () =>
  defineDriver(shop, {
    order: {
      get: async () => ({ total: 1 }),
      refund: async () => ({ ok: true }),
      // @ts-expect-error the connector does not declare order.cancel
      cancel: async () => ({ ok: true }),
    },
  });

/** Never called: only typed. */
export const startsTyped = (client: SanomaClient) => [
  client.start(wf, { id: "o1" }, { startedBy: { id: "alice" } }),
  // @ts-expect-error the input is checked against the workflow's schema: `id` is a string
  client.start(wf, { id: 1 }, { startedBy: { id: "alice" } }),
  // @ts-expect-error the input is the schema's input: `id` is required
  client.start(wf, {}, { startedBy: { id: "alice" } }),
];

describe("types", () => {
  it("keys a driver's operations by resource and name", () => {
    expect(shopDriver.vendor).toBe("shop");
    expect(Object.keys(shopDriver.ops)).toEqual(["order.get", "order.refund"]);
    expect(wrongInput).not.toThrow();
    expect(wrongOutput).not.toThrow();
  });

  it("refuses a driver that is incomplete or implements undeclared operations", () => {
    expect(incomplete).toThrow('defineDriver("shop"): it does not implement shop.order.refund');
    expect(undeclared).toThrow(/it implements shop\.order\.cancel, which the connector does not declare/);
  });

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
