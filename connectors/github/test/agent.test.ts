import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import { github } from "../src/index.ts";

const company = { workflows: [], connectors: [github], databaseUrl: "postgresql://localhost:5433/not_opened" };

it("gives the chat Copilot, on a person's own plan only, with its own mark", () => {
  expect(describeConfig(company).agents).toEqual([
    {
      id: "copilot",
      vendor: "github",
      title: "Copilot",
      mark: { src: expect.stringMatching(/^data:image\/svg\+xml/), dark: expect.any(String) },
      own: true,
    },
  ]);
  expect(resolveConfig(company).agents.get("copilot")?.own).toMatchObject({
    bin: "copilot",
    args: ["--acp"],
    signIn: { run: ["login", "--device-code"] },
  });
});
