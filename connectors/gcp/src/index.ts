import { withSetup } from "sanoma/workflows";
import { gcpTf } from "./connector.ts";
import { checkIdentity, gcpAuthentication, type GcpIdentity } from "./authentication.ts";
import { gcpDriver } from "./driver.ts";
import { fakeGcp } from "./fake.ts";

export type { GcpIdentity } from "./authentication.ts";

/**
 * Google Cloud as one provisioning identity, its facts declared here (project, project number,
 * service account, WIF audience, issuer): a connection on its `workloadIdentity` method stores
 * only the provisioning bearer, entered on the connector page. Without an identity, as `gcp`,
 * every live verification and call is refused.
 */
export function gcpWithIdentity(identity?: GcpIdentity) {
  const checked = identity && checkIdentity(identity);
  const method = gcpAuthentication(checked);
  return withSetup(gcpTf.connector, {
    authentication: { workloadIdentity: method },
    driver: () => gcpDriver(checked, method),
    fake: fakeGcp,
  });
}

/** Operations and resources for authoring and sandbox runs; a live call needs `gcpWithIdentity`. */
export const gcp = gcpWithIdentity();
