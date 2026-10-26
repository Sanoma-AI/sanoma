import { resolveConfig } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { expect, it } from "vitest";
import { anthropic } from "../src/index.ts";
import { anthropicModel } from "../src/model.ts";

const company = { workflows: [], connectors: [anthropic], databaseUrl: "postgresql://localhost:5433/not_opened" };

it("is a connector with no operations, a driver declaring its key and a model half, as the app reads it", () => {
  const description = describeConfig(company);
  expect(description.vendors.anthropic).toMatchObject({
    title: "Anthropic",
    package: "@sanoma-ai/connector-anthropic",
    fake: false,
    logo: { src: expect.stringMatching(/^data:image\/svg\+xml/), dark: expect.any(String) },
  });
  expect(description.ops.filter((op) => op.vendor === "anthropic")).toEqual([]);

  const resolved = resolveConfig(company);
  expect(resolved.driversByVendor.get("anthropic")?.env?.shape).toHaveProperty("ANTHROPIC_API_KEY");
  expect(resolved.models.get("anthropic")).toBe(anthropicModel);
});
