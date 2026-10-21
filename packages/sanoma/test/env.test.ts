import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Connector,
  defineConnector,
  type Driver,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
  withSetup,
} from "@sanoma-ai/workflows";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { renderEnvExample, writeEnvExample } from "../src/env.ts";

const shop: Driver = {
  vendor: "shop",
  ops: {},
  env: z.object({
    SHOP_API_KEY: z.string().min(1).describe("an API key with read and refund access"),
    SHOP_BASE_URL: z.string().optional().describe("the API's base URL; default https://api.shop.example"),
  }),
};
const mail: Driver = { vendor: "mail", ops: {}, env: z.object({ MAIL_TOKEN: z.string().min(1) }) };

/** A connector of `driver`'s vendor, with no operations, carrying `driver` and no fake. */
const carrying = (driver: Driver): Connector<any, any> =>
  withSetup(defineConnector(driver.vendor, {}), { driver: () => driver });

const config: SanomaConfig = {
  workflows: [],
  connectors: [carrying(shop), carrying(mail)],
  ledger: memoryLedger(),
};

/** The config as the bin loads it, in `root`. */
const loaded = (cfg: SanomaConfig, root = "") => ({ config: cfg, root, resolved: resolveConfig(cfg) });

const expected = `# Copy to .env (ignored by git; \`sanoma\` loads it before reading the config). Never commit values.
# The first block is what sanoma needs before anything runs. The vendor variables below it can
# also be set on the app's connector pages (stored in the database and loaded by the worker); a
# value set here wins over a stored one and cannot be changed from the page. An empty value is
# the same as unset.

# Optional. Postgres for the worker and the app; default postgresql://postgres:dbos@localhost:5433/sanoma.
# SANOMA_DATABASE_URL=
# Optional. Encrypts the stored credentials, and signs GitHub sign-in's cookie: 32 random bytes,
# base64. \`sanoma\` writes one here when none is set; keep it with the database.
# SANOMA_SECRETS_KEY=
# Optional. The app's port; default 3000.
# SANOMA_APP_PORT=
# Optional. The address the app listens on; default 127.0.0.1. Any other needs GitHub sign-in.
# SANOMA_APP_HOST=
# Optional. GitHub sign-in: the OAuth client of the company's GitHub App. Who may sign in is
# resources/people.ts. Both or neither.
# SANOMA_GITHUB_CLIENT_ID=
# SANOMA_GITHUB_CLIENT_SECRET=

# shop: an API key with read and refund access
SHOP_API_KEY=
# Optional. shop: the API's base URL; default https://api.shop.example
# SHOP_BASE_URL=

# mail
MAIL_TOKEN=
`;

describe("renderEnvExample", () => {
  it("lists sanoma's variables, then each vendor's in the connectors' order, optional ones commented out", () => {
    expect(renderEnvExample(loaded(config))).toBe(expected);
  });

  it("names the config's own database URL as the default when it has one", () => {
    expect(renderEnvExample(loaded({ ...config, databaseUrl: "postgresql://me@db.internal/ops" }))).toContain(
      "default postgresql://me@db.internal/ops.",
    );
  });
});

describe("writeEnvExample", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the file, says when it would change, and leaves it alone with check", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-env-"));
    expect(writeEnvExample(loaded(config, dir), { check: true })).toEqual({ changed: true });
    expect(writeEnvExample(loaded(config, dir), { check: false })).toEqual({ changed: true });
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toBe(expected);
    expect(writeEnvExample(loaded(config, dir), { check: true })).toEqual({ changed: false });
    expect(writeEnvExample(loaded(config, dir), { check: false })).toEqual({ changed: false });
    writeFileSync(join(dir, ".env.example"), "stale\n");
    expect(writeEnvExample(loaded(config, dir), { check: true })).toEqual({ changed: true });
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toBe("stale\n");
  });
});
