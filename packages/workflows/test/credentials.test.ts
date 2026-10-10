import { blueskyDriver } from "@sanoma/connector-bluesky/driver";
import { ghostDriver } from "@sanoma/connector-ghost/driver";
import { githubDriver } from "@sanoma/connector-github/driver";
import { resendDriver } from "@sanoma/connector-resend/driver";
import { stripeDriver } from "@sanoma/connector-stripe/driver";
import { testDatabaseUrl } from "@sanoma/testing";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineDriver,
  defineWorkflow,
  errorCode,
  memoryLedger,
  SanomaClient,
  type SanomaConfig,
  startWorker,
} from "../src/index.ts";
import { credentialsOf } from "../src/config.ts";
import { ensureTable } from "../src/credentials.ts";
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
  [REGION_VAR]: z.enum(["us", "eu"]).describe("the region; default us").optional(),
});
const impl = { thing: { get: async ({ id }: { id: string }) => ({ id }) } };
const acmeDriver = defineDriver(acme, impl, { env });
const plain = defineDriver(acme, impl);
const getThing = defineWorkflow({
  name: "get-thing",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [acme.thing.get],
  run: async (ctx, { id }) => ctx.acme.thing.get({ id }),
});
const databaseUrl = testDatabaseUrl("credentials");
const config: SanomaConfig = {
  workflows: [getThing],
  connectors: [acme],
  drivers: [acmeDriver],
  policy: allowAll,
  ledger: memoryLedger(),
  appName: "credentials",
  databaseUrl,
};
/** Sets and clears the stored credentials, as the app does. */
let client: SanomaClient;

beforeAll(async () => {
  client = await SanomaClient.connect(config);
});

afterAll(async () => {
  await client?.close();
});

// The table outlives a run of the tests: each starts with nothing stored.
beforeEach(async () => {
  for (const name of [URL_VAR, KEY_VAR, REGION_VAR]) await client.clearCredential(name, { by: "tester" });
});
/** acme's statuses as the worker checks them, against `process.env`. */
const checked = (drivers = config.drivers) => credentialsOf(drivers, (name) => process.env[name]).get("acme");
const statuses = () => checked()?.map(({ name, status }) => [name, status]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a driver's env", () => {
  it("is kept on the driver, which is frozen", () => {
    expect(acmeDriver.env).toBe(env);
    expect(Object.isFrozen(acmeDriver)).toBe(true);
    expect(Object.isFrozen(acmeDriver.ops)).toBe(true);
    expect(plain).not.toHaveProperty("env");
  });

  it("is checked against process.env: set, missing, empty and invalid, never the value", () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    vi.stubEnv(REGION_VAR, undefined);
    expect(checked()).toEqual([
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
    const [url, key] = checked()!;
    expect(url).toMatchObject({ status: "invalid", problem: "Invalid URL" });
    expect(key).toMatchObject({ status: "invalid", problem: "an API key, key_<letters>" });
    expect(JSON.stringify([url, key])).not.toMatch(/not a url|NOT-LOWER/);
  });

  it("is invalid, without the value, when its check throws", async () => {
    const VALUE = "madeup-not-a-url";
    vi.stubEnv(URL_VAR, VALUE);
    const throwing = defineDriver(acme, impl, {
      env: z.object({ [URL_VAR]: z.string().refine((v) => new URL(v).protocol === "https:") }),
    });
    const throwingConfig = { ...config, drivers: [throwing] };
    const credentials = checked(throwingConfig.drivers);
    expect(credentials).toEqual([{ name: URL_VAR, optional: false, status: "invalid", problem: "its check threw" }]);
    const refusal = await startWorker(throwingConfig).then(
      () => undefined,
      (err: Error) => err.message,
    );
    expect(refusal).toContain(`${URL_VAR} is invalid (its check threw)`);
    expect(JSON.stringify([credentials, refusal])).not.toContain(VALUE);
  });

  it("merges two drivers' declarations of one variable, keeping the worse status", async () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    const stricter = defineDriver(acme, impl, {
      env: z.object({ [KEY_VAR]: z.string().regex(/^key_[0-9]+$/, "an API key, key_<digits>") }),
    });
    const twoDrivers = { ...config, drivers: [acmeDriver, stricter] };
    expect(checked(twoDrivers.drivers)?.[1]).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "invalid",
      problem: "an API key, key_<digits>",
    });
    await expect(startWorker(twoDrivers)).rejects.toThrow(`${KEY_VAR} is invalid (an API key, key_<digits>)`);
  });
});

describe("startWorker", () => {
  it("refuses, before launching, naming the vendor and each variable that is missing or invalid", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    vi.stubEnv(REGION_VAR, undefined);
    const refusal = await startWorker(config).then(
      () => undefined,
      (err: Error) => err.message,
    );
    expect(refusal).toBe(
      `The worker cannot start: acme: ${URL_VAR} is missing (the account's API URL), ${KEY_VAR} is invalid (an API key, key_<letters>). ` +
        "Set them on the app's connector pages, or in its environment",
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

describe("describeConfig", () => {
  it("carries no credentials, and no value: SanomaClient.credentials has their statuses", async () => {
    vi.stubEnv(KEY_VAR, KEY);
    const { vendors } = await describeConfig(config);
    expect(vendors.acme).not.toHaveProperty("credentials");
    expect(JSON.stringify(vendors)).not.toContain(KEY);
  });
});

/** What the call throws, as its code, message and data in one string, to look for a value in. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: { message: string; data?: unknown }) => ({
      code: errorCode(err),
      message: err.message,
      text: `${err.message} ${JSON.stringify(err.data)}`,
    }),
  );

/** acme's statuses as `credentials()` gives them. */
const stored = async (from = client) => (await from.credentials()).get("acme");

describe("stored credentials", () => {
  it("are kept in one table, made with its database when no worker has made that, and made again harmlessly", async () => {
    const fresh = testDatabaseUrl("credentials_fresh");
    const admin = new URL(fresh);
    const name = admin.pathname.slice(1);
    admin.pathname = "/postgres";
    const server = new Pool({ connectionString: admin.toString() });
    const pool = new Pool({ connectionString: fresh });
    try {
      await server.query(`DROP DATABASE IF EXISTS "${name}"`);
      await Promise.all([ensureTable(fresh), ensureTable(fresh)]);
      await ensureTable(fresh);
      const { rows } = await pool.query("SELECT to_regclass('sanoma_credentials')::text AS t");
      expect(rows).toEqual([{ t: "sanoma_credentials" }]);
    } finally {
      await pool.end();
      await server.end();
    }
  });

  it("are set, replaced and cleared, with who set them and when, never the value", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, undefined);
    vi.stubEnv(REGION_VAR, undefined);
    expect((await stored())?.[1]).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "missing",
    });

    const before = Date.now() - 60_000;
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    const [, key] = (await stored())!;
    expect(key).toMatchObject({ name: KEY_VAR, status: "set", source: "stored", setBy: "alice" });
    expect(Date.parse(key!.setAt!)).toBeGreaterThan(before);

    await client.setCredential(KEY_VAR, "key_replaced", { by: "bob" });
    expect((await stored())?.[1]).toMatchObject({ status: "set", source: "stored", setBy: "bob" });
    expect(JSON.stringify([...(await client.credentials())])).not.toMatch(/key_madeupvalue|key_replaced/);

    await client.clearCredential(KEY_VAR, { by: "bob" });
    expect((await stored())?.[1]).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "missing",
    });
  });

  it("are refused for a name no driver declares, and without someone setting them", async () => {
    for (const p of [
      client.setCredential("SANOMA_TEST_UNDECLARED", KEY, { by: "alice" }),
      client.clearCredential("SANOMA_TEST_UNDECLARED", { by: "alice" }),
    ]) {
      const { code, message, text } = await refusal(p);
      expect(code).toBe("invalid_input");
      expect(message).toBe(
        `No driver declares SANOMA_TEST_UNDECLARED; the declared variables are ${URL_VAR}, ${KEY_VAR}, ${REGION_VAR}`,
      );
      expect(text).not.toContain(KEY);
    }
    expect((await refusal(client.setCredential(KEY_VAR, KEY, { by: "" }))).code).toBe("invalid_input");
    expect((await stored())?.[1]?.status).toBe("missing");
  });

  it("refuses a value its schema refuses, or an empty one, with the reason and without the value", async () => {
    const VALUE = "key_NOT-LOWER";
    const invalid = await refusal(client.setCredential(KEY_VAR, VALUE, { by: "alice" }));
    expect(invalid).toMatchObject({
      code: "invalid_input",
      message: `${KEY_VAR} cannot be set: an API key, key_<letters>`,
    });
    expect(invalid.text).toContain(
      '"issues":[{"path":["value"],"message":"an API key, key_<letters>","code":"custom"}]',
    );
    expect(invalid.text).not.toContain(VALUE);

    const empty = await refusal(client.setCredential(KEY_VAR, "", { by: "alice" }));
    expect(empty.message).toBe(`${KEY_VAR} cannot be set: it is empty; clear it to unset it`);
    expect((await stored())?.[1]?.status).toBe("missing");
  });

  it("refuses a value whose check throws, without the value", async () => {
    const VALUE = "madeup-not-a-url";
    const throwing = defineDriver(acme, impl, {
      env: z.object({ [URL_VAR]: z.string().refine((v) => new URL(v).protocol === "https:") }),
    });
    const other = await SanomaClient.connect({ ...config, drivers: [throwing] });
    try {
      const { message, text } = await refusal(other.setCredential(URL_VAR, VALUE, { by: "alice" }));
      expect(message).toBe(`${URL_VAR} cannot be set: its check threw`);
      expect(text).not.toContain(VALUE);
    } finally {
      await other.close();
    }
  });

  it("are overridden by the environment, which credentials() says is the source", async () => {
    vi.stubEnv(KEY_VAR, "key_fromenv");
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    const [, key] = (await stored())!;
    expect(key).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "set",
      source: "environment",
    });
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    expect((await stored())?.[1]).toMatchObject({ status: "invalid", source: "environment" });
  });
});

describe("a worker's credentials", () => {
  it("are loaded from the table at start, reloaded on each change, and never replace the environment's", async () => {
    const FROM_ENV = "https://acme.example.test";
    vi.stubEnv(URL_VAR, FROM_ENV);
    vi.stubEnv(KEY_VAR, undefined);
    vi.stubEnv(REGION_VAR, undefined);
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    await client.setCredential(URL_VAR, "https://stored.example.test", { by: "alice" });
    const said = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // KEY_VAR is not in the environment: only its stored value lets the worker start.
    const worker = await startWorker(config);
    try {
      expect(process.env[KEY_VAR]).toBe(KEY);
      expect(process.env[URL_VAR]).toBe(FROM_ENV);
      expect(said).toHaveBeenCalledWith("sanoma: credentials loaded for acme (1 variable)");

      await client.setCredential(KEY_VAR, "key_rotated", { by: "bob" });
      await vi.waitFor(() => expect(process.env[KEY_VAR]).toBe("key_rotated"));
      await client.setCredential(REGION_VAR, "eu", { by: "bob" });
      await vi.waitFor(() => expect(process.env[REGION_VAR]).toBe("eu"));
      await client.clearCredential(KEY_VAR, { by: "bob" });
      await vi.waitFor(() => expect(process.env).not.toHaveProperty(KEY_VAR));
      // Its stored value was never loaded, so clearing it leaves the environment's. The worker
      // reloads one change at a time, so once it has the next, it has handled this one.
      await client.clearCredential(URL_VAR, { by: "bob" });
      await client.setCredential(REGION_VAR, "us", { by: "bob" });
      await vi.waitFor(() => expect(process.env[REGION_VAR]).toBe("us"));
      expect(process.env[URL_VAR]).toBe(FROM_ENV);
      expect(said.mock.calls.flat()).toEqual([
        "sanoma: credentials loaded for acme (1 variable)",
        ...Array(4).fill("sanoma: credentials reloaded for acme (1 variable)"),
      ]);
    } finally {
      await worker.stop();
    }
  });
});

describe("the connectors' drivers", () => {
  const bridge = {} as never;
  it.each([
    ["ghost", ghostDriver(), ["GHOST_ADMIN_URL", "GHOST_ADMIN_API_KEY"], []],
    ["resend", resendDriver(), ["RESEND_API_KEY"], []],
    [
      "bluesky",
      blueskyDriver(),
      ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD", "BLUESKY_SERVICE"],
      ["BLUESKY_SERVICE"],
    ],
    ["github", githubDriver({ bridge }), ["GITHUB_TOKEN"], []],
    ["stripe", stripeDriver({ bridge }), ["STRIPE_API_KEY"], []],
  ])("%s declares exactly its variables, each described, and which are optional", (_, driver, names, optional) => {
    const shape = driver.env!.shape;
    expect(Object.keys(shape)).toEqual(names);
    for (const schema of Object.values(shape)) expect(schema.description).toBeTruthy();
    const optionals = Object.entries(shape).filter(([, schema]) => schema.safeParse(undefined).success);
    expect(optionals.map(([name]) => name)).toEqual(optional);
  });
});
