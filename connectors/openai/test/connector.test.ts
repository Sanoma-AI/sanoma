import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import { openai } from "../src/index.ts";

const company = { workflows: [], connectors: [openai], databaseUrl: "postgresql://localhost:5433/not_opened" };

it("is a connector with no operations that gives the chat Codex, on a person's own plan only", () => {
  const { vendors, ops, agents } = describeConfig(company);
  expect(vendors.openai).toMatchObject({ title: "OpenAI", package: "@sanoma-ai/connector-openai", fake: false });
  expect(vendors.openai?.logo).toEqual({ src: expect.any(String), dark: expect.any(String) });
  expect(ops.filter((op) => op.vendor === "openai")).toEqual([]);
  expect(agents).toEqual([
    {
      id: "codex",
      vendor: "openai",
      title: "Codex",
      mark: { src: expect.stringMatching(/^data:image\/svg\+xml/), dark: expect.any(String) },
      own: true,
    },
  ]);
  expect(resolveConfig(company).agents.get("codex")?.own).toMatchObject({
    bin: "codex-acp",
    signIn: { authenticate: "chat-gpt-device-code" },
  });
});
