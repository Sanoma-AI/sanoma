# @sanoma/connector-stripe

Stripe resources for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows): products and webhook endpoints, read through the [`stripe/stripe`](https://github.com/stripe/terraform-provider-stripe) OpenTofu provider (0.3.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge). It reads only: there is no create, update or delete yet.

## Contents

| Path                              | What it is                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| [`src/`](src/AGENTS.md)           | The connector, the resource types (generated and hand-owned), the driver and the fake |
| [`test/`](test/AGENTS.md)         | The generated types against the replies, the driver over a replay, and the fake       |
| [`testdata/`](testdata/AGENTS.md) | Replies written by hand to the provider's schema                                      |

## Usage

```sh
npm install @sanoma/connector-stripe
```

Each resource type has two operations, both effect `read` and idempotent, with Stripe's id as the policy's `target`:

| Type               | Operations                                                       | Import id (identity) |
| ------------------ | ---------------------------------------------------------------- | -------------------- |
| `product`          | `stripe.product.read`, `stripe.product.import`                   | `id` (`prod_…`)      |
| `webhook_endpoint` | `stripe.webhook_endpoint.read`, `stripe.webhook_endpoint.import` | `id` (`we_…`)        |

`import` takes `{ id }` and returns the object's `state`; `read` takes a state an earlier call returned, or just `{ id }`, and returns its fresh `state`, or `gone: true`. See [Resources](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/AGENTS.md#resources).

A data file declares resources with the constructors in `@sanoma/connector-stripe/resources`, naming an object that exists by Stripe's id:

```ts
import { stripe } from "@sanoma/connector-stripe/resources";

export const pro = stripe.product({ id: "prod_…", name: "Pro", active: true });
```

The fields are the provider's attributes, by their names. Only declared fields are compared for drift; `id` is Stripe's, so never compared.

The logo is Stripe's glyph from [Simple Icons](https://simpleicons.org/?q=stripe) (CC0), there only to identify the service an operation calls.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate`, which runs [`@sanoma/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/src/tfschema/AGENTS.md) with `src/resources.config.ts`: the provider (its release, sha256 and recorded schema are `@sanoma/bridge`'s pin and fixture), the types, and the attributes whose change replaces the object (a webhook endpoint's `api_version` and `connect`, which Stripe's update does not take). It is checked in and never edited by hand; `pnpm generate` on a clean tree changes nothing. `src/connector.ts` is the rest, one `tfConnector` record from [`@sanoma/bridge/connector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/AGENTS.md#connectors-for-opentofu-providers): each type found by Stripe's `id`, and Stripe's title and logo. What Stripe sets (`created`, `livemode`) is vendor-owned and a data file may not declare it; `id` is too, but the identity names it, so a data file gives it.

A webhook endpoint's `secret` is sensitive (Stripe returns it only when the endpoint is created): it is write-only, never compared, and `null` in every state the driver returns.

## Driver

`@sanoma/connector-stripe/driver` reads through a provider bridge. Workflows never import it; the config that starts the worker does:

```ts
import { stripeDriver } from "@sanoma/connector-stripe/driver";

const drivers = [stripeDriver({ bridge })]; // bridge: `startBridge()` from @sanoma/bridge
```

It configures the provider on the first call with `{ api_key }`, and again when the key changes, when the provider has exited, or when the bridge has forgotten it. `read` without a state imports, which reads the object too.

### Environment

Read on every call, never when the config loads:

| Variable         | What it is                                                   |
| ---------------- | ------------------------------------------------------------ |
| `STRIPE_API_KEY` | A Stripe secret or restricted key; a test-mode one in tests. |

When it is unset, a call fails, not retryable, naming it. The bridge passes it to the provider through its config only.

### Errors and retries

As for GitHub: the bridge's errors become `DriverError`s with its code as `vendorCode` and the provider's diagnostics in the message, retryable only on `unavailable`, after which the provider is configured again. A Stripe error (a bad key, an id that does not exist) comes back from the provider as a failed import (`failed_precondition`) with Stripe's message, the key masked.

## Testing

`@sanoma/connector-stripe/fake` serves the replies in `testdata/replies` (a test-mode product `prod_SanomaTest0001` and webhook endpoint `we_SanomaTest0001`) through the real driver over a `stateBridge` of them (`tfFake`). Those replies are written by hand to the provider's schema, not recorded: no Stripe key was at hand when provider-bridge recorded GitHub's. Replace them with recorded ones (provider-bridge's `bridge-record`) when there is one.

```ts
import { fakeStripe } from "@sanoma/connector-stripe/fake";

const fake = fakeStripe();
fake.override("product", "prod_SanomaTest0001", { name: "Renamed" }); // drift: the next read returns it
```

It has `remove` and the faults every fake has, like `fakeGithub`. `@sanoma/testing` re-exports `fakeStripe`.

License: Apache-2.0.
