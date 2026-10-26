import { withSetup } from "@sanoma-ai/workflows";
import { cloudflareOps } from "./connector.ts";
import { cloudflareDriver } from "./driver.ts";
import { fakeCloudflare } from "./fake.ts";
import { cloudflareSteps } from "./steps.ts";

/**
 * Cloudflare: the resource types `cloudflare.container`, the company's Worker and its Container,
 * which meets the `Host` contract, and `cloudflare.alarm`, its Durable Object's alarm, which meets
 * the `Wakeup` contract (`read`, `import`, `plan`, `create`, `update`, `delete` each), and
 * `cloudflare.alarm.register` (effect `write`), which the worker registers each deadline through
 * before it stops. It carries its live driver (`cloudflareDriver`), which reads its credentials
 * when called, its fake (`fakeCloudflare`), of which each sandbox run makes its own, and its steps
 * for Gherkin tests (`cloudflareSteps`).
 */
export const cloudflare = withSetup(cloudflareOps, {
  driver: cloudflareDriver,
  fake: fakeCloudflare,
  steps: cloudflareSteps,
});
