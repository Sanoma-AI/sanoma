import { withSetup } from "@sanoma/workflows";
import { resendOps } from "./connector.ts";
import { resendDriver } from "./driver.ts";
import { fakeResend } from "./fake.ts";

/**
 * Resend broadcasts: `broadcast.create` and `broadcast.send`. It carries its live driver
 * (`resendDriver`), which reads its credentials when called, and its fake (`fakeResend`), of
 * which each sandbox run makes its own.
 */
export const resend = withSetup(resendOps, { driver: resendDriver, fake: fakeResend });
