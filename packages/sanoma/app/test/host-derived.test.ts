import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflare } from "@sanoma-ai/connector-cloudflare";
import { neon } from "@sanoma-ai/connector-neon";
import { resolveConfig } from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { afterAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/context.ts";
import { hostDerived } from "../src/server/host-derived.ts";

// The Hosting page's read-only facts of the declared host that derives (`hostDerived`): what apply
// gives it, told as apply tells it, each key with whether it is stored. No database: the store is
// a map, and the root's facts are given as a snapshot carries them.

const root = mkdtempSync(join(tmpdir(), "sanoma-host-derived-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "resources", "sanoma"), { recursive: true });
writeFileSync(
  join(root, "resources", "sanoma", "infra.ts"),
  [
    'import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";',
    'import { neon } from "@sanoma-ai/connector-neon/resources";',
    "",
    'export const store = neon.project({ name: "acme", region: "aws-us-east-1" });',
    "export const host = cloudflare.host({",
    '  name: "acme",',
    "  database: store,",
    '  agents: { url: "https://mcp.sanoma.example/mcp", company: "acme" },',
    "});",
    "",
  ].join("\n"),
);
const config = { workflows: [], connectors: [cloudflare, neon], root };

/** The app's context as `hostDerived` reads it, over a store holding `stored`. */
const contextOver = (stored: Record<string, string>) =>
  ({
    resolved: resolveConfig(config),
    snapshot: {
      description: describeConfig(config),
      host: { version: "1.2.3", origin: "https://github.com/acme/company.git", domains: {}, branches: {} },
    },
    client: {
      secrets: async (names: readonly string[]) =>
        new Map(names.flatMap((name) => (name in stored ? [[name, { value: stored[name]! }] as const] : []))),
    },
  }) as unknown as AppContext;

/** What the page lists of the router's secret, over a store holding `stored`. */
const keyOf = async (stored: Record<string, string>) =>
  (await hostDerived(contextOver(stored)))?.keys.find((key) => key.name === "SANOMA_ROUTER_SECRET");

describe("the Hosting page's facts of a host that derives", () => {
  it("lists the router's secret of a host declared behind a router, stored or not", async () => {
    // Not stored: listed all the same, so the page says what apply would refuse the host for.
    expect(await keyOf({})).toEqual({ name: "SANOMA_ROUTER_SECRET", stored: false });
    expect(await keyOf({ SANOMA_ROUTER_SECRET: "0123456789abcdef".repeat(4) })).toEqual({
      name: "SANOMA_ROUTER_SECRET",
      stored: true,
    });
  });
});
