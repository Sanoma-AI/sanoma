// The tests are named after the feature files and scenarios.
/* oxlint-disable vitest/valid-title, vitest/expect-expect */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowAll, type Connector, memoryLedger, resolveConfig } from "@sanoma/workflows";
import { featureScenarios, type FeatureTarget, testFeature } from "@sanoma/workflows/scenario";
import { describe, it } from "vitest";
import { live, replay, type ReplayOptions } from "./replay.ts";

/** Tags a scenario that runs on the fake only: no recording of the vendor's replies holds it. */
export const FAKE_ONLY = "@fake-only";

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

/** The fixture a scenario replays: its name in lower case, each run of other characters than letters and digits a `-`. */
export const fixtureOf = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

/**
 * Registers the connector's own feature files as vitest tests: a `describe` per target, `fake`
 * and `replay`, and in each a test per scenario that runs it with Cucumber (`testFeature`), its
 * `When` steps calling the target's operations directly. The fake is a new one of the
 * connector's per scenario; replay is the connector's driver over the scenario's recorded
 * replies (`replay`), skipped for a scenario tagged `@fake-only` and when `SANOMA_LIVE=1`. Steps
 * are the connector's (`withSetup`'s `steps`) and the generic ones.
 */
export function describeFeatures(
  connector: Connector<any, any>,
  { features, replay: options }: DescribeFeaturesOptions,
) {
  const resolve = () =>
    resolveConfig({ workflows: [], connectors: [connector], policy: allowAll, ledger: memoryLedger() });
  // One scope, so Cucumber's library is built once; each test makes its own fake, or driver.
  const scope = resolve();
  const vendor = scope.ops.values().next().value?.vendor;
  if (vendor === undefined) throw new Error("describeFeatures needs a connector with operations");
  const scenarios = featureScenarios(features);
  if (scenarios.length === 0) throw new Error(`describeFeatures found no scenarios in ${fileURLToPath(features)}`);

  /** Runs the scenario on the target, and throws its first failure. */
  async function run(file: string, line: number, target: () => FeatureTarget) {
    const failure = await testFeature(scope, fileURLToPath(new URL(file, features)), line, target());
    if (failure) throw new Error(failure.message);
  }

  describe("fake", () => {
    for (const { file, line, name } of scenarios) {
      it(`${file} › ${name}`, () =>
        run(file, line, () => {
          const fake = scope.fakes.get(vendor)?.();
          if (!fake) throw new Error(`${vendor}'s connector attaches no fake`);
          return { driver: fake.driver, fake };
        }));
    }
  });

  describe.skipIf(live)("replay", () => {
    const { play } = replay(options);
    for (const { file, line, name, tags } of scenarios) {
      const fixture = fixtureOf(name);
      it.skipIf(tags.includes(FAKE_ONLY))(`${file} › ${name}`, () => {
        if (!existsSync(new URL(`${fixture}.json`, options.fixtures))) {
          throw new Error(
            `${file}:${line}: no recording ${fixture}.json for "${name}" in ${fileURLToPath(options.fixtures)}; record one, or tag the scenario ${FAKE_ONLY}`,
          );
        }
        play(fixture);
        return run(file, line, () => {
          // A driver of its own, as each run's would be: one that keeps a session starts without one.
          const driver = resolve().driversByVendor.get(vendor);
          if (!driver) throw new Error(`${vendor}'s connector attaches no driver`);
          return { driver };
        });
      });
    }
  });
}
