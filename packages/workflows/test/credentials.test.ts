import { blueskyDriver } from "@sanoma/connector-bluesky/driver";
import { ghostDriver } from "@sanoma/connector-ghost/driver";
import { githubDriver } from "@sanoma/connector-github/driver";
import { resendDriver } from "@sanoma/connector-resend/driver";
import { stripeDriver } from "@sanoma/connector-stripe/driver";
import { bluesky } from "@sanoma/connector-bluesky";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  credentialReady,
  defineConnector,
  defineDriver,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  type SanomaConfig,
  startWorker,
} from "../src/index.ts";
import { describeConfig } from "../src/describe.ts";

// Made-up variables and values: nothing here is a credential.
const URL_VAR = "SANOMA_TEST_ACME_URL";
const KEY_VAR = "SANOMA_TEST_ACME_KEY";
const REGION_VAR = "SANOMA_TEST_ACME_REGION";
const KEY = "key_madeupvalue";

const acme = defineConnector("acme", {
  thing: { get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) } },
});
const env = z.object({
  [URL_VAR]: z.url().describe("the account's API URL"),
  [KEY_VAR]: z
    .string()
    .regex(/^key_[a-z]+$/, "an API key, key_<letters>")
    .describe("an API key"),
  // Described before it is made optional: the description is still found.
  [REGION_VAR]: z.enum(["us", "eu"]).describe("the region; default us").optional(),
});
const acmeDriver = defineDriver(acme, { thing: { get: async ({ id }) => ({ id }) } }, { env });
const getThing = defineWorkflow({
  name: "get-thing",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [acme.thing.get],
  run: async (ctx, { id }) => ctx.acme.thing.get({ id }),
});
// Refused before the worker connects, so no database is needed.
const config: SanomaConfig = {
  workflows: [getThing],
  connectors: [acme],
  drivers: [acmeDriver],
  policy: allowAll,
  ledger: memoryLedger(),
  databaseUrl: "postgresql://unused@localhost:1/unused",
};
const statuses = () =>
  resolveConfig(config)
    .credentials.get("acme")
    ?.map(({ name, status }) => [name, status]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a driver's env", () => {
  it("is kept on the driver, which is frozen", () => {
    expect(acmeDriver.env).toBe(env);
    expect(Object.isFrozen(acmeDriver)).toBe(true);
    expect(Object.isFrozen(acmeDriver.ops)).toBe(true);
    expect(defineDriver(acme, { thing: { get: async ({ id }) => ({ id }) } })).not.toHaveProperty("env");
  });

  it("is checked by resolveConfig against process.env: set, missing, empty and invalid, never the value", () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    vi.stubEnv(REGION_VAR, undefined);
    expect(resolveConfig(config).credentials.get("acme")).toEqual([
      { name: URL_VAR, description: "the account's API URL", optional: false, status: "set" },
      { name: KEY_VAR, description: "an API key", optional: false, status: "set" },
      { name: REGION_VAR, description: "the region; default us", optional: true, status: "missing" },
    ]);

    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "");
    expect(statuses()).toEqual([
      [URL_VAR, "missing"],
      [KEY_VAR, "missing"],
      [REGION_VAR, "missing"],
    ]);

    vi.stubEnv(URL_VAR, "not a url");
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    const [url, key] = resolveConfig(config).credentials.get("acme")!;
    expect(url).toMatchObject({ status: "invalid", problem: "Invalid URL" });
    expect(key).toMatchObject({ status: "invalid", problem: "an API key, key_<letters>" });
    expect(JSON.stringify([url, key])).not.toMatch(/not a url|NOT-LOWER/);
  });

  it("has no entry for a vendor whose drivers declare none", () => {
    const plain = defineDriver(acme, { thing: { get: async ({ id }) => ({ id }) } });
    expect(resolveConfig({ ...config, drivers: [plain] }).credentials.size).toBe(0);
  });
});

describe("startWorker", () => {
  it("refuses, before connecting, naming the vendor and each variable that is missing or invalid", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    vi.stubEnv(REGION_VAR, undefined);
    const refusal = await startWorker(config).then(
      () => undefined,
      (err: Error) => err.message,
    );
    expect(refusal).toBe(
      `The worker cannot start: acme needs ${URL_VAR} (the account's API URL), ${KEY_VAR} is invalid (an API key, key_<letters>). ` +
        "Set them in its environment (locally, in .env)",
    );
    expect(refusal).not.toContain("NOT-LOWER");
  });

  it("refuses an invalid variable even when it is optional", async () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    vi.stubEnv(REGION_VAR, "mars");
    await expect(startWorker(config)).rejects.toThrow(
      `The worker cannot start: acme: ${REGION_VAR} is invalid (Invalid option: expected one of "us"|"eu").`,
    );
  });
});

describe("credentialReady", () => {
  it("is true for a variable that is set, or unset and optional", () => {
    const base = { name: "X", optional: false };
    expect(credentialReady({ ...base, status: "set" })).toBe(true);
    expect(credentialReady({ ...base, status: "missing" })).toBe(false);
    expect(credentialReady({ ...base, optional: true, status: "missing" })).toBe(true);
    expect(credentialReady({ ...base, optional: true, status: "invalid", problem: "Invalid URL" })).toBe(false);
  });
});

describe("describeConfig", () => {
  it("carries each vendor's credentials, without their values", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, KEY);
    const { vendors } = await describeConfig(config);
    expect(vendors.acme?.credentials?.map(({ name, status }) => [name, status])).toEqual([
      [URL_VAR, "missing"],
      [KEY_VAR, "set"],
      [REGION_VAR, "missing"],
    ]);
    expect(JSON.stringify(vendors)).not.toContain(KEY);
  });

  it("gives no credentials to a vendor whose drivers declare none", async () => {
    const plain = defineDriver(acme, { thing: { get: async ({ id }) => ({ id }) } });
    const { vendors } = await describeConfig({ ...config, drivers: [plain] });
    expect(vendors.acme).not.toHaveProperty("credentials");
  });
});

describe("the connectors' drivers", () => {
  const bridge = {} as never;
  it.each([
    ["ghost", ghostDriver(), ["GHOST_ADMIN_URL", "GHOST_ADMIN_API_KEY"]],
    ["resend", resendDriver(), ["RESEND_API_KEY"]],
    ["bluesky", blueskyDriver(), ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD", "BLUESKY_SERVICE"]],
    ["github", githubDriver({ bridge }), ["GITHUB_TOKEN"]],
    ["stripe", stripeDriver({ bridge }), ["STRIPE_API_KEY"]],
  ])("%s declares exactly its variables, each described", (_, driver, names) => {
    expect(Object.keys(driver.env!.shape)).toEqual(names);
    for (const schema of Object.values(driver.env!.shape)) expect(schema.description).toBeTruthy();
  });

  it("marks BLUESKY_SERVICE optional, and only it", () => {
    vi.stubEnv("BLUESKY_IDENTIFIER", "");
    vi.stubEnv("BLUESKY_APP_PASSWORD", "");
    vi.stubEnv("BLUESKY_SERVICE", "");
    const { credentials } = resolveConfig({
      ...config,
      connectors: [acme, bluesky],
      drivers: [acmeDriver, blueskyDriver()],
    });
    expect(credentials.get("bluesky")?.map(({ name, optional }) => [name, optional])).toEqual([
      ["BLUESKY_IDENTIFIER", false],
      ["BLUESKY_APP_PASSWORD", false],
      ["BLUESKY_SERVICE", true],
    ]);
  });
});
