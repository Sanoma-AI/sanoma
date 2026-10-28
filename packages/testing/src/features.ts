// The tests are named after the feature files and scenarios.
/* oxlint-disable vitest/valid-title, vitest/expect-expect */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type CallContext,
  type Connector,
  type Driver,
  type DriverFn,
  errorMessage,
  memoryLedger,
  memorySecrets,
  resolveConfig,
} from "@sanoma-ai/workflows";
import {
  FEATURE_STEP_MS,
  featureScenarios,
  type FeatureTarget,
  type Scope,
  testFeature,
} from "@sanoma-ai/workflows/scenario";
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

/**
 * The driver with what a scenario creates noted, to delete after it (live, so nothing stays on
 * the account; replaying, as recorded): each call of a resource type's `create` that returned an
 * id, last first, through the type's `delete` with that id, as apply deletes; an `update` that
 * replaced one under a new id moves its note to that id; one the scenario deleted itself is left
 * out. Returns what could not be deleted, and why.
 */
function deletingAfter(scope: Scope, driver: Driver): { driver: Driver; deleteMade(): Promise<string[]> } {
  /** Each object made, by its type's `delete` op id and the id its `create` returned. */
  const made: { del: string; id: string }[] = [];
  const inFlight = new Set<Promise<unknown>>();
  const ops: Record<string, DriverFn> = { ...driver.ops };
  for (const [key, fn] of Object.entries(driver.ops)) {
    const op = scope.ops.get(`${driver.vendor}.${key}`);
    if (!op || !scope.types.has(`${op.vendor}.${op.resource}`)) continue;
    const del = scope.ops.get(`${op.vendor}.${op.resource}.delete`);
    if (!del) continue;
    if (op.name === "create") {
      ops[key] = (input, context) => {
        const creating = fn(input, context).then((output) => {
          const id = (output as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") made.push({ del: del.id, id });
          return output;
        });
        inFlight.add(creating);
        creating.catch(() => undefined).finally(() => inFlight.delete(creating));
        return creating;
      };
    } else if (op.name === "update") {
      ops[key] = async (input, context) => {
        const output = await fn(input, context);
        const { id } = input as { id?: unknown };
        const now = (output as { id?: unknown } | undefined)?.id;
        const noted = made.find((m) => m.del === del.id && m.id === id);
        if (noted && typeof now === "string") noted.id = now;
        return output;
      };
    } else if (op.name === "delete") {
      ops[key] = async (input, context) => {
        const output = await fn(input, context);
        const { id } = input as { id?: unknown };
        const at = made.findIndex((m) => m.del === del.id && m.id === id);
        if (at >= 0) made.splice(at, 1);
        return output;
      };
    }
  }
  return {
    driver: { ...driver, ops },
    async deleteMade() {
      // A create the scenario stopped waiting for (a step's timeout) may still be making its object.
      await Promise.allSettled(inFlight);
      const left: string[] = [];
      const secrets = memorySecrets();
      // A run id of its own, so a vendor that keeps idempotency keys never answers with another cleanup's reply.
      const runId = `cleanup:${randomUUID()}`;
      for (const [n, m] of made.splice(0).toReversed().entries()) {
        const del = scope.ops.get(m.del)!;
        const context: CallContext = {
          idempotencyKey: `${runId}:${n}`,
          runId,
          opId: del.id,
          attempt: 1,
          secrets,
        };
        try {
          await driver.ops[`${del.resource}.${del.name}`]!({ id: m.id }, context);
        } catch (err) {
          left.push(`${del.id} ${m.id}: ${errorMessage(err)}`);
        }
      }
      return left;
    },
  };
}

/** How long a scenario may take live: a step's longest (a `Given` seeding an object as apply makes it), then the deletes after it. */
const LIVE_TIMEOUT = live ? { timeout: FEATURE_STEP_MS + 5 * 60_000 } : {};

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
  const resolve = () => resolveConfig({ workflows: [], connectors: [connector], ledger: memoryLedger() });
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
      it.skipIf(tags.includes(FAKE_ONLY))(`${file} › ${name}`, LIVE_TIMEOUT, async () => {
        if (!live && !existsSync(new URL(`${fixture}.json`, options.fixtures))) {
          throw new Error(
            `${file}:${line}: no recording ${fixture}.json for "${name}" in ${fileURLToPath(options.fixtures)}; record one with SANOMA_LIVE=1 SANOMA_RECORD=1, or tag the scenario ${FAKE_ONLY}`,
          );
        }
        play(fixture);
        // A driver of its own, as each run's would be: one that keeps a session starts without one.
        const driver = resolve().driversByVendor.get(vendor);
        if (!driver) throw new Error(`${vendor}'s connector attaches no driver`);
        // What the scenario made is deleted after it, whether it passed or not: live, off the
        // account; replaying, from the recording, which holds those deletes.
        const { driver: noting, deleteMade } = deletingAfter(scope, driver);
        let failed: unknown;
        try {
          await run(file, line, { driver: noting, live });
        } catch (err) {
          failed = err;
        }
        const left = await deleteMade();
        if (left.length) {
          const message = `not deleted after the scenario: ${left.join("; ")}`;
          throw new Error(failed === undefined ? message : `${errorMessage(failed)}\n${message}`);
        }
        if (failed !== undefined) throw failed;
      });
    }
  });
}
