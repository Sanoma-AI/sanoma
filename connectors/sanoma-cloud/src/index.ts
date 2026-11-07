import { withSetup } from "sanoma/workflows";
import { cloudOps } from "./connector.ts";
import { cloudDriver } from "./driver.ts";
import { fakeCloud } from "./fake.ts";

export { REGIONS } from "./connector.ts";

/**
 * Sanoma Cloud: the resource types `cloud.database`, which meets the `Database` contract,
 * with `database.storeUrl`, and `cloud.host`, which meets the `Host` contract and binds its
 * own bootstrap (`read`, `import`, `plan`, `create`, `update`, `delete` each), over sanoma-ops's
 * `cloud-*` workflows. It carries its live driver (`cloudDriver`), which reads the Cloud
 * token when called, and its fake (`fakeCloud`), of which each sandbox run makes its own.
 */
export const cloud = withSetup(cloudOps, {
  driver: cloudDriver,
  fake: fakeCloud,
});
