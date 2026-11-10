import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import { opencode } from "../src/index.ts";

const company = { workflows: [], connectors: [opencode], databaseUrl: "postgresql://localhost:5433/not_opened" };

it("is a connector with no operations that gives the chat OpenCode, on a person's own plan only, its mark its logo", () => {
  const { vendors, ops, agents } = describeConfig(company);
  expect(vendors.opencode).toMatchObject({ title: "OpenCode", package: "@sanoma-ai/connector-opencode", fake: false });
  expect(ops.filter((op) => op.vendor === "opencode")).toEqual([]);
  expect(agents).toEqual([
    { id: "opencode", vendor: "opencode", title: "OpenCode", mark: vendors.opencode?.logo, own: true, once: true },
  ]);
  expect(resolveConfig(company).agents.get("opencode")?.own).toMatchObject({
    bin: "opencode",
    setup: "node_modules/opencode-ai/postinstall.mjs",
    signIn: { once: { bin: "opencode", args: ["auth", "login"] } },
  });
});
