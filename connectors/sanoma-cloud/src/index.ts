import { withSetup } from "sanoma/workflows";
import { cloudBackend } from "./backend.ts";
import { cloudOps } from "./connector.ts";
import { cloudDriver, workflowsApi } from "./driver.ts";
import { fakeCloud } from "./fake.ts";

export { BOX_INPUTS, boxProblem } from "./boxes.ts";
export { REGIONS } from "./connector.ts";

/**
 * Sanoma Cloud: the resource types `cloud.database`, which meets the `Database` contract,
 * with `database.storeUrl`, `cloud.host`, which meets the `Host` contract and binds its
 * own bootstrap, and `cloud.sandbox`, which meets the `Sandbox` contract (`read`, `import`,
 * `plan`, `create`, `update`, `delete` each), over sanoma-ops's `cloud-*` workflows. It carries
 * its live driver (`cloudDriver`), which reads the Cloud token when called, its fake
 * (`fakeCloud`), of which each sandbox run makes its own, and the backend that opens the
 * company's agent boxes (`cloudBackend`) with the Cloud token from the company's secrets.
 */
export const cloud = withSetup(cloudOps, {
  driver: cloudDriver,
  fake: fakeCloud,
  sandbox: ({ secrets }) => cloudBackend(workflowsApi(async (name) => (await secrets([name])).get(name))),
});
