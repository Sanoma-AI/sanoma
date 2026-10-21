import { withSetup } from "@sanoma-ai/workflows";
import { resendOps } from "./connector.ts";
import { resendDriver } from "./driver.ts";
import { fakeResend } from "./fake.ts";
import { resendSteps } from "./steps.ts";

/**
 * Resend broadcasts, `broadcast.create` and `broadcast.send`, and one email, `emails.send`. It
 * carries its live driver (`resendDriver`), which reads its credentials when called, its fake
 * (`fakeResend`), of which each sandbox run makes its own, and its steps for Gherkin tests
 * (`resendSteps`).
 */
export const resend = withSetup(resendOps, { driver: resendDriver, fake: fakeResend, steps: resendSteps });
