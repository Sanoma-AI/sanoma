import { withSetup } from "@sanoma-ai/workflows";
import { neonOps } from "./connector.ts";
import { neonDriver } from "./driver.ts";
import { fakeNeon } from "./fake.ts";
import { neonSteps } from "./steps.ts";
import { neonApiKey } from "./authentication.ts";

export { REGIONS } from "./connector.ts";
export { neonApiKey } from "./authentication.ts";

/**
 * Neon, serverless Postgres: the resource type `neon.project` (`read`, `import`, `plan`,
 * `create`, `update`, `delete`), which meets the `Database` contract, with `project.health` and
 * `project.storeUrl`; `branch.create` and `branch.delete`; `endpoint.suspend` and
 * `endpoint.start`. It carries its live driver (`neonDriver`), which reads its key when called,
 * its fake (`fakeNeon`), of which each sandbox run makes its own, and its steps for Gherkin tests
 * (`neonSteps`).
 */
export const neon = withSetup(neonOps, {
  authentication: { apiKey: neonApiKey },
  driver: neonDriver,
  fake: fakeNeon,
  steps: neonSteps,
});
