import { tfFake, type TfFakeOptions } from "@sanoma-ai/bridge/fake";
import { gcpTf } from "./connector.ts";
import { constrain, retainKeys } from "./constraints.ts";

export const fakeGcp = (options: TfFakeOptions = {}) =>
  tfFake(
    {
      ...gcpTf,
      driver(bridge, config, importId, observe, authentication) {
        const driver = gcpTf.driver(retainKeys(bridge), config, importId, observe, authentication);
        return {
          ...driver,
          ops: Object.fromEntries(
            Object.entries(driver.ops).map(([operation, run]) => [
              operation,
              // A sandbox has synthetic connection metadata, never a production identity source.
              (input, call) =>
                run(constrain(operation, input), { ...call, connection: undefined, authentication: undefined }),
            ]),
          ),
        };
      },
    },
    options,
  );
