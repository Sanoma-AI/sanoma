import { withSetup } from "@sanoma-ai/workflows";
import { gcpTf } from "./connector.ts";
import { gcpAuthentication, type GcpIdentities } from "./authentication.ts";
import { gcpDriver } from "./driver.ts";
import { fakeGcp } from "./fake.ts";

export type { GcpIdentities, GcpIdentity } from "./authentication.ts";

/** Bind named connections to trusted deployment WIF files; configuration contains no secret values. */
export function gcpWithIdentities(identities: GcpIdentities) {
  const configured = Object.freeze(
    Object.fromEntries(Object.entries(identities).map(([id, identity]) => [id, Object.freeze({ ...identity })])),
  );
  return withSetup(gcpTf.connector, {
    authentication: { workloadIdentity: gcpAuthentication(configured) },
    driver: () => gcpDriver(configured),
    fake: fakeGcp,
  });
}

/** Operations/resources for authoring. Live use requires gcpWithIdentities in deployment config. */
export const gcp = gcpWithIdentities({});
