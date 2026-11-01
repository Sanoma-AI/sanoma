import { fileURLToPath } from "node:url";
import { resolveConfig } from "@sanoma-ai/workflows";
import { featureScenarios, testFeature } from "@sanoma-ai/workflows/scenario";
import { describe, expect, it } from "vitest";
import { invoicesDriver } from "../src/driver.ts";
import { fakeInvoices } from "../src/fake.ts";
import { invoices } from "../src/index.ts";

// Local generation has no HTTP exchange to record. Both targets execute the real generator.
const scope = resolveConfig({ workflows: [], connectors: [invoices] });
const features = new URL("../features/", import.meta.url);
const scenarios = await featureScenarios(scope, features);
describe.each(["driver", "fake"] as const)("%s features", (target) => {
  it.each(scenarios)("$name", async ({ file, line }) => {
    const fake = fakeInvoices();
    await expect(
      testFeature(
        scope,
        fileURLToPath(new URL(file, features)),
        line,
        target === "fake" ? { driver: fake.driver, fake } : { driver: invoicesDriver() },
      ),
    ).resolves.toBeUndefined();
  });
});
