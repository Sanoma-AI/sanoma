// The tests are named after the feature files and scenarios.
/* oxlint-disable vitest/valid-title, vitest/expect-expect */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowAll, type Connector, memoryLedger, resolveConfig } from "@sanoma-ai/workflows";
import { featureScenarios, type FeatureTarget, testFeature } from "@sanoma-ai/workflows/scenario";
import { describe, it } from "vitest";
import { live, replay, type ReplayOptions } from "./replay.ts";

export interface DescribeFeaturesOptions {
  /** The connector's feature files' directory: `new URL("../features/", import.meta.url)`. */
  features: URL;
  /**
   * How the connector's vendor is replayed (`replay`'s options, as its driver tests use them).
   * Each scenario replays the fixture named after it: its name in lower case, each run of other
   * characters a `-` (`Publish draft` plays `publish-draft.json`).
   */
  replay: ReplayOptions;
}

/** Tags a scenario that runs on the fake only: no recording of the vendor's replies holds it. */
const FAKE_ONLY = "@fake-only";

/** The fixture a scenario replays: its name in lower case, each run of other characters than letters and digits a `-`. */
const fixtureOf = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

/**
 * Registers the connector's own feature files as vitest tests: a `describe` per target, `fake`
 * and `driver`, and in each a test per scenario that runs it with Cucumber (`testFeature`), its
 * `When` steps calling the target's operations directly. The fake is a new one of the
 * connector's per scenario. The driver is the connector's, over the scenario's recorded replies
 * (`replay`), or with `SANOMA_LIVE=1` against the vendor, where `SANOMA_RECORD=1` records the
 * replies as the scenario's fixture; a scenario tagged `@fake-only` runs on the fake alone.
 * Steps are the connector's (`withSetup`'s `steps`) and the generic ones. Await it: it lists the
 * scenarios first.
 */
export async function describeFeatures(
  connector: Connector<any, any>,
  { features, replay: options }: DescribeFeaturesOptions,
) {
  const resolve = () =>
    resolveConfig({ workflows: [], connectors: [connector], policy: allowAll, ledger: memoryLedger() });
  // One scope, so Cucumber's library is built once; each test makes its own fake, or driver.
  const scope = resolve();
  const vendor = scope.ops.values().next().value?.vendor;
  if (vendor === undefined) throw new Error("describeFeatures needs a connector with operations");
  const scenarios = await featureScenarios(scope, features);
  if (scenarios.length === 0) throw new Error(`describeFeatures found no scenarios in ${fileURLToPath(features)}`);
  const run = (file: string, line: number, target: FeatureTarget) =>
    testFeature(scope, fileURLToPath(new URL(file, features)), line, target);

  describe("fake", () => {
    for (const { file, line, name } of scenarios) {
      it(`${file} › ${name}`, () => {
        const fake = scope.fakes.get(vendor)?.();
        if (!fake) throw new Error(`${vendor}'s connector attaches no fake`);
        return run(file, line, { driver: fake.driver, fake });
      });
    }
  });

  describe("driver", () => {
    const { play } = replay(options);
    for (const { file, line, name, tags } of scenarios) {
      const fixture = fixtureOf(name);
      it.skipIf(tags.includes(FAKE_ONLY))(`${file} › ${name}`, () => {
        if (!live && !existsSync(new URL(`${fixture}.json`, options.fixtures))) {
          throw new Error(
            `${file}:${line}: no recording ${fixture}.json for "${name}" in ${fileURLToPath(options.fixtures)}; record one with SANOMA_LIVE=1 SANOMA_RECORD=1, or tag the scenario ${FAKE_ONLY}`,
          );
        }
        play(fixture);
        // A driver of its own, as each run's would be: one that keeps a session starts without one.
        const driver = resolve().driversByVendor.get(vendor);
        if (!driver) throw new Error(`${vendor}'s connector attaches no driver`);
        return run(file, line, { driver });
      });
    }
  });
}
