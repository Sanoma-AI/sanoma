# connectors/stripe/testdata

Replies in the recorder's format, written by hand to the provider's schema (`@sanoma/bridge`'s `testdata/schemas/stripe_stripe_0.3.0.json`). Not formatted by oxfmt.

## Contents

| Path                                                 | What it is                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`replies/stripe_stripe_0.3.0/`](replies/)           | Import and read replies for a product and a webhook endpoint, which the fake serves          |

The replies are not recorded: provider-bridge has no Stripe recording yet (no key was on the recording machine). Each file says so in its `synthetic` field. They follow the schema's implied type (every attribute present, `null` when unset, blocks as lists) with made-up values, ids `prod_SanomaTest0001` and `we_SanomaTest0001`. Re-record them with provider-bridge's `bridge-record` and a test-mode key, and copy them here.
