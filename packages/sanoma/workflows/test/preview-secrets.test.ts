import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { databaseUrlSecret } from "../src/database.ts";
import { DEPLOYMENT_KEYS } from "../src/deployment-key.ts";
import { GITHUB_APP, HOST_SIGNING_KEY, SOURCE_KEY } from "../src/host-derive.ts";
import { previewSecretSet } from "../src/preview.ts";
import { WAKEUP_TOKEN } from "../src/wakeup-service.ts";

// A preview's secret set (#600): its names, and that none is one the live instance keeps its own under.

/** The names the live instance keeps its own secrets under, and the prefix of its databases' URLs. */
const live = new Set([
  ...DEPLOYMENT_KEYS,
  HOST_SIGNING_KEY,
  SOURCE_KEY,
  WAKEUP_TOKEN,
  "SANOMA_WAKEUP_URL",
  ...Object.values(GITHUB_APP),
]);
const databaseUrls = databaseUrlSecret("store").replace(/STORE$/, "");
const names = (change: string) => Object.values(previewSecretSet(change).environment).map((s) => s.$secret);

describe("previewSecretSet", () => {
  it("names a change's schema and the variables it is started with, each the preview's own", () => {
    expect(previewSecretSet("3f2a9c1e-acme-draft")).toEqual({
      schema: "preview_3f2a9c1e_acme_draft",
      environment: {
        SANOMA_DATABASE_URL: { $secret: "SANOMA_PREVIEW_3F2A9C1E_ACME_DRAFT_DATABASE_URL" },
        SANOMA_SIGNING_KEY: { $secret: "SANOMA_PREVIEW_3F2A9C1E_ACME_DRAFT_SIGNING_KEY", generate: true },
        SANOMA_SECRETS_KEY: { $secret: "SANOMA_PREVIEW_3F2A9C1E_ACME_DRAFT_SECRETS_KEY", generate: true },
        SANOMA_SOURCE_KEY: { $secret: "SANOMA_PREVIEW_3F2A9C1E_ACME_DRAFT_SOURCE_KEY" },
      },
    });
  });

  it("names nothing the live instance keeps, and nothing another change's preview does", () => {
    const changes = [randomUUID(), "fix-pricing", "fix_pricing", "Fix-Pricing", "x".repeat(64)];
    const all = changes.flatMap(names);
    for (const name of all) {
      expect(live.has(name)).toBe(false);
      expect(name.startsWith(databaseUrls)).toBe(false);
    }
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(changes.map((c) => previewSecretSet(c).schema)).size).toBe(changes.length);
  });

  it("keeps every schema (and role) a Postgres identifier, and refuses what is no draft's id", () => {
    for (const change of [randomUUID(), "a", "x".repeat(50), "x".repeat(51), "Mixed_Case-64".padEnd(64, "z")]) {
      expect(previewSecretSet(change).schema).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    }
    for (const change of ["", "draft/1", "x".repeat(65), "a b"])
      expect(() => previewSecretSet(change)).toThrow("Not a draft's id");
  });
});
