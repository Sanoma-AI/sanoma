---
title: "Build a connector"
description: "Define a vendor’s operations, attach a driver and a fake, and check that they agree."
sidebar:
  order: 1
---

A connector gives company workflows a typed interface to a vendor. First [check the catalog](/reference/connectors/) to see which operations already exist.

1. **Declare the operations.** Give each one an ID, effect, input schema, and output schema. The shop example below exposes an order lookup and a refund. The workflow shows how someone will call them.
2. **Implement the driver.** Use [the driver API](/workflows/connectors/) to translate a typed operation into a vendor request. Keep credentials and HTTP handling in the driver.
3. **Attach a fake.** Implement the same operations against [in-memory vendor state](/testing/fakes/). Export the connector with its driver and fake attached using `withSetup`. A company can then register the exported connector in its config.
4. **Check both implementations.** Write a feature for one operation and [run the conformance suite](/testing/conformance/) against the fake and the driver with recorded replies. Assert the same visible result in both runs.

## A connector and a workflow

A connector declares each vendor operation’s input, output, and effect. List the operations the workflow needs in `uses`, then call them on `ctx`. To call a [company operation](/workflows/your-own-operations/), declare it with `defineOperation` in `operations/`, list it in `uses`, and call `ctx.operations.<name>.run`.

```ts
import { defineConnector, defineWorkflow } from "sanoma/workflows";
import { z } from "zod";

const shop = defineConnector("shop", {
  order: {
    get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ total: z.number() }) },
    refund: { effect: "money", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
});

export default defineWorkflow({
  name: "refund",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [shop.order.get, shop.order.refund, "approval"],
  run: async (ctx, { id }) => {
    const order = await ctx.shop.order.get({ id });
    // Covers the refund below, so the policy lets it through without asking again.
    await ctx.approval(`Refund ${order.total}`, { approver: "finance-lead", covers: [shop.order.refund] });
    return ctx.shop.order.refund({ id });
  },
});
```

## Describing the vendor

A third argument says who the vendor is, so the app can show it: `defineConnector("shop", specs, { title: "Shop", logo: { svg, dark }, package, homepage })`. `logo.svg` is the vendor's mark as inline SVG markup, one `<svg>…</svg>` element (`defineConnector` refuses anything else, such as a file path or a URL), and `logo.dark` its variant for dark backgrounds, if it has one. The app shows a logo before each of the vendor's operations, in graphs and lists, and only ever as an image (`<img>` with a `data:` URL), where an SVG's scripts and external references never run or load.

A vendor with no logo is shown by its operations' ids alone, as before. `package` is the connector's npm package name (`"@sanoma-ai/connector-resend"`), which the app's Connectors page links to on npm.

`homepage` is the connector package's `homepage` from its package.json: where its code and README are, as an https URL (`defineConnector` refuses anything else); the Connectors page links to it as the connector's source. A vendor whose operations are split over several connectors is described by the first connector's info, its package and homepage as well as its title and logo.

A connector package writes all of this once, in its package.json, and passes `vendorInfo(import.meta.url)` as the third argument (the nearest package.json is read): it reads the `"sanoma": { "title", "logo", "logoDark"?, "agent"? }` field, whose logos are SVG files in the package (relative `.svg` paths, listed in `files`), and the package's `name` and `homepage`. With the `sanoma-connector` keyword, the same field is how the app lists the package on npm before it is installed.

## Drivers and fakes

A [driver](/workflows/connectors/) implements the operations and holds the credentials, and a [fake](/testing/fakes/) stands in for the vendor in [sandbox runs](/testing/scenarios/). A connector package attaches both to the connector it exports, with `withSetup` (and its [steps](/testing/conformance/#steps-a-connector-ships) for Gherkin tests, as `steps`), so a config names the connector alone:

```ts
// The connector package's root, such as @acme/connector-shop.
export const shop = withSetup(defineConnector("shop", specs, info), {
  driver: shopDriver, // made once per resolved config
  fake: fakeShop, // made once per sandbox run: each has its own
});
```

`withSetup` lays what it is given over what the connector already carries, and keeps it on the connector's vendor record, so a spread copy of the connector keeps it too. A config that needs a driver made otherwise (another bridge, other options) swaps the driver and keeps the fake: `withSetup(github, { driver: () => githubDriver({ bridge }) })`. It is for connector packages and configs, not for workflows, which the lint does not let import it.

Both are optional: a connector without a driver declares its operations and implements none, so a workflow using one is refused; a connector without a fake has none for sandbox runs, which the app's connector page says.

## Targets

An operation names the instance it acts on with `target`, a function of its parsed input, so a policy can decide per post or per order rather than per operation (its Cedar resource, `Sanoma::Target::"order/ord_1"`). TypeScript types its input `any` there, so annotate it to have it checked:

```ts
const shop = defineConnector("shop", {
  order: {
    refund: {
      effect: "money",
      input: z.object({ id: z.string() }),
      output,
      target: ({ id }: { id: string }) => `order/${id}`,
    },
  },
});
```
