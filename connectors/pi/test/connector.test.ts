import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import { pi } from "../src/index.ts";

const company = { workflows: [], connectors: [pi], databaseUrl: "postgresql://localhost:5433/not_opened" };

it("is a connector with no operations that gives the chat Pi, on a person's own plan and on Anthropic's key", () => {
  const { vendors, ops, agents } = describeConfig(company);
  expect(vendors.pi).toMatchObject({ title: "Pi", package: "@sanoma-ai/connector-pi", fake: false });
  expect(ops.filter((op) => op.vendor === "pi")).toEqual([]);
  // Anthropic's by contract: the connector imports none, and a config without it still describes Pi.
  expect(agents).toEqual([
    {
      id: "pi",
      vendor: "pi",
      title: "Pi",
      mark: vendors.pi?.logo,
      own: true,
      once: true,
      onKey: { model: "anthropic" },
    },
  ]);
  expect(resolveConfig(company).agents.get("pi")).toMatchObject({
    own: { bin: "pi-acp", signIn: { once: { bin: "pi", args: [], after: "/login" } } },
    onKey: { model: "anthropic", baseUrl: "ANTHROPIC_BASE_URL", qualified: true, bridge: false },
  });
});

it("loads Pi's adapter only when a turn on the key asks for it, its settings under the session's home", async () => {
  const home = mkdtempSync(join(tmpdir(), "connector-pi-"));
  try {
    const harness = await resolveConfig(company).agents.get("pi")!.onKey!.harness({ ANTHROPIC_API_KEY: "x" }, home);
    expect(harness.specificationVersion).toBe("harness-v1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
