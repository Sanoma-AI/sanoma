import { withSetup } from "@sanoma/workflows";
import { resend as declared } from "./connector.ts";
import { resendDriver } from "./driver.ts";
import { fakeResend } from "./fake.ts";

/**
 * Resend broadcasts: `broadcast.create` and `broadcast.send`. It carries its live driver
 * (`resendDriver`), which reads its credentials when called, and its fake (`fakeResend`), which
 * sandbox runs and scenarios copy.
 */
export const resend = withSetup(declared, { driver: () => resendDriver(), fake: () => fakeResend() });
