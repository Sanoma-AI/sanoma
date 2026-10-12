# connectors/stripe/test

Tests for the Stripe connector. They run on the replies in `../testdata`, with no key and no network.

## Contents

| Path                                     | What it is                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts) | The generated types parse the replies; flagged fields, operations and identities                                                                            |
| [`driver.test.ts`](driver.test.ts)       | `stripeDriver` over a `stateBridge`: import, configuration, errors, the default bridge and the declared variables; `fakeStripe`, without the webhook secret |
