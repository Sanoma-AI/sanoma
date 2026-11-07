import { withSetup } from "sanoma/workflows";
import { resendOps } from "./connector.ts";
import { resendDriver } from "./driver.ts";
import { fakeResend } from "./fake.ts";
import { resendSteps } from "./steps.ts";

/**
 * Resend broadcasts, `broadcast.create` and `broadcast.send`, one email, `emails.send`, and the
 * resource type `resend.domain` (`read`, `import`, `plan`, `create`, `update`, `delete`), a
 * domain Resend sends from. It carries its live driver (`resendDriver`), which reads its credentials when called, its fake
 * (`fakeResend`), of which each sandbox run makes its own, and its steps for Gherkin tests
 * (`resendSteps`).
 */
export const resend = withSetup(resendOps, { driver: resendDriver, fake: fakeResend, steps: resendSteps });
