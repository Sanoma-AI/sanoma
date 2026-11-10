import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
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

it("gives the chat Claude Code, on a person's own plan and on this connector's key", () => {
  const { agents } = describeConfig(company);
  expect(agents).toEqual([
    {
      id: "claude-code",
      vendor: "anthropic",
      title: "Claude Code",
      mark: { src: expect.stringMatching(/^data:image\/svg\+xml/) },
      own: true,
      onKey: { model: "anthropic" },
    },
  ]);
  const claudeCode = resolveConfig(company).agents.get("claude-code")!;
  expect(claudeCode.own).toMatchObject({ bin: "claude-agent-acp", signIn: { method: "claude-ai-login" } });
  expect(claudeCode.onKey).toMatchObject({ model: "anthropic", qualified: false, bridge: true });
});

it("loads Claude Code's adapter only when a turn on the key asks for it", async () => {
  const harness = await resolveConfig(company)
    .agents.get("claude-code")!
    .onKey!.harness({ ANTHROPIC_API_KEY: "x" }, "/");
  expect(harness.specificationVersion).toBe("harness-v1");
});
