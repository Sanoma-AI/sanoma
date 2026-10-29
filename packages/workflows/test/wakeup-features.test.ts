import { describeFeatures } from "@sanoma-ai/testing/features";
import { sanomaWakeup } from "../src/config.ts";
import { withSetup, setupOf, type CallContext } from "../src/op.ts";
import { memorySecretStore, SecretAccess } from "../src/secret-store.ts";
import { replayOptions } from "./wakeup-replay.ts";

// test/features/wakeup.feature, `sanoma.wakeup`'s own, on the fake and on the recorded replies in test/fixtures/wakeup.
const replayConnector = withSetup(sanomaWakeup, {
  driver: () => {
    const driver = setupOf(sanomaWakeup).driver!();
    const secrets = new SecretAccess(
      {
        bindings: {
          SANOMA_WAKEUP_URL: { env: "SANOMA_WAKEUP_URL" },
          SANOMA_WAKEUP_ACCOUNT_TOKEN: { env: "SANOMA_WAKEUP_ACCOUNT_TOKEN" },
        },
      },
      memorySecretStore(),
    );
    return {
      ...driver,
      ops: Object.fromEntries(
        Object.entries(driver.ops).map(([name, fn]) => [
          name,
          (input: unknown, context: CallContext) => fn(input, { ...context, secrets }),
        ]),
      ),
    };
  },
});
await describeFeatures(replayConnector, { features: new URL("./features/", import.meta.url), replay: replayOptions });
