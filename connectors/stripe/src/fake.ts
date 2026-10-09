import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma/bridge/fake";
import { stripeTf } from "./connector.ts";

/** The replies the fake serves, written by hand to the provider's schema: there is no Stripe recording yet. */
const fixtures = new URL("../testdata/", import.meta.url);

export type FakeStripeState = TfFakeState;
export type FakeStripeOptions = TfFakeOptions;

/**
 * A Stripe that answers through the real driver over a bridge of the replies in `testdata/`, a
 * test-mode product (`prod_SanomaTest0001`) and webhook endpoint (`we_SanomaTest0001`). Those
 * replies are written by hand to the provider's schema, not recorded: no Stripe key was at hand
 * when the GitHub ones were. Nothing reaches Stripe, and no key is read.
 *
 * `override` changes what the next read returns, as if someone edited the object in Stripe's
 * dashboard, and `remove` deletes it, so the next read says it is gone.
 */
export const fakeStripe = (options: FakeStripeOptions = {}) => tfFake(stripeTf, { fixtures, ...options });
