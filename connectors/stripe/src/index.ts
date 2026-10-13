import { withSetup } from "@sanoma/workflows";
import { stripeTf } from "./connector.ts";
import { stripeDriver } from "./driver.ts";
import { fakeStripe } from "./fake.ts";

/**
 * Stripe resources, read through the `stripe/stripe` OpenTofu provider: each type has a `read`
 * and an `import` operation (`stripe.product.read`), both effect `read`. It carries its live
 * driver (`stripeDriver`, on the default bridge) and its fake (`fakeStripe`), which sandbox runs
 * and scenarios copy.
 */
export const stripe = withSetup(stripeTf.connector, { driver: stripeDriver, fake: fakeStripe });
