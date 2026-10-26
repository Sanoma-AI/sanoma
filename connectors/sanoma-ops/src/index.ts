import { withSetup } from "@sanoma-ai/workflows";
import { sanomaOpsOps } from "./connector.ts";
import { sanomaOpsDriver } from "./driver.ts";
import { fakeSanomaOps } from "./fake.ts";
import { sanomaOpsSteps } from "./steps.ts";

/**
 * sanoma-ops's wakeup service: the resource type `sanomaOps.wakeup` (`read`, `import`, `plan`,
 * `create`, `update`, `delete`), which meets the `Wakeup` contract, and `sanomaOps.wakeup.register`
 * (effect `write`), which the worker registers each deadline through before it stops. It carries
 * its live driver (`sanomaOpsDriver`), which reads its credentials when called, its fake
 * (`fakeSanomaOps`), of which each sandbox run makes its own, and its steps for Gherkin tests
 * (`sanomaOpsSteps`).
 */
export const sanomaOps = withSetup(sanomaOpsOps, {
  driver: sanomaOpsDriver,
  fake: fakeSanomaOps,
  steps: sanomaOpsSteps,
});
